import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { DiffFile, ImpactRadius } from './types';

// ─── Import Graph Builder ─────────────────────────────────────────────────────

interface ImportMap {
  [filePath: string]: string[]; // file -> list of files it imports
}

// Scan a TypeScript/JavaScript file for import statements
function extractImports(filePath: string, rootDir: string): string[] {
  const imported: string[] = [];

  if (!fs.existsSync(filePath)) return imported;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return imported;
  }

  const importPatterns = [
    /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic imports
  ];

  for (const pattern of importPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];
      if (!importPath) continue;

      // Skip node_modules
      if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

      const resolved = resolveImportPath(filePath, importPath, rootDir);
      if (resolved) imported.push(resolved);
    }
  }

  return imported;
}

// Resolve a relative import path to an absolute path
function resolveImportPath(
  fromFile: string,
  importPath: string,
  rootDir: string
): string | null {
  const fromDir = path.dirname(fromFile);
  const resolved = path.resolve(fromDir, importPath);

  // Try with various extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];

  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      return path.relative(rootDir, candidate);
    }
  }

  // Already has extension
  if (fs.existsSync(resolved)) {
    return path.relative(rootDir, resolved);
  }

  return null;
}

// Build a reverse import map: for each file, which files import it
function buildReverseImportMap(
  rootDir: string,
  fileExtensions: string[] = ['.ts', '.tsx', '.js', '.jsx']
): Record<string, string[]> {
  const reverseMap: Record<string, string[]> = {};

  const allFiles = findSourceFiles(rootDir, fileExtensions);

  for (const file of allFiles) {
    const absPath = path.join(rootDir, file);
    const imports = extractImports(absPath, rootDir);

    for (const imported of imports) {
      if (!reverseMap[imported]) reverseMap[imported] = [];
      reverseMap[imported].push(file);
    }
  }

  return reverseMap;
}

// Recursively find all source files in a directory
function findSourceFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) return results;

  const ignoreDirs = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next'];

  function walk(currentDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignoreDirs.includes(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(dir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(relativePath);
      }
    }
  }

  walk(dir);
  return results;
}

// ─── Impact Radius Calculator ─────────────────────────────────────────────────

export async function calculateImpactRadius(
  changedFiles: DiffFile[],
  rootDir: string = process.cwd()
): Promise<ImpactRadius> {
  core.info('Calculating impact radius...');

  const directFiles = changedFiles.map(f => f.path);
  const transitiveSet = new Set<string>();
  const affectedServices = new Set<string>();
  const modifiedEndpoints: string[] = [];

  let requiresIntegrationTests = false;
  let requiresContractTests = false;

  try {
    const reverseMap = buildReverseImportMap(rootDir);

    // BFS from each changed file through the reverse import graph
    const queue = [...directFiles];
    const visited = new Set<string>(directFiles);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const callers = reverseMap[current] ?? [];

      for (const caller of callers) {
        if (!visited.has(caller)) {
          visited.add(caller);
          transitiveSet.add(caller);
          queue.push(caller);
        }
      }
    }

    // Determine if integration tests are needed
    // Heuristic: if changes affect files in different top-level directories
    const changedDirs = new Set(directFiles.map(f => f.split('/')[0]));
    const transitiveDirs = new Set(Array.from(transitiveSet).map(f => f.split('/')[0]));

    for (const dir of transitiveDirs) {
      if (!changedDirs.has(dir)) {
        requiresIntegrationTests = true;
        affectedServices.add(dir);
      }
    }

    // Detect API endpoint changes
    for (const file of changedFiles) {
      if (isControllerFile(file.path)) {
        requiresContractTests = true;
        const endpoints = extractEndpointsFromDiff(file.patch);
        modifiedEndpoints.push(...endpoints);
      }
    }
  } catch (err: unknown) {
    const error = err as { message?: string };
    core.warning(`Impact radius calculation failed: ${error.message}. Defaulting to unit tests only.`);
  }

  return {
    directFiles,
    transitiveFiles: Array.from(transitiveSet),
    affectedServices: Array.from(affectedServices),
    modifiedEndpoints,
    requiresIntegrationTests,
    requiresContractTests,
  };
}

// Heuristic: is this file a controller/route handler?
function isControllerFile(filePath: string): boolean {
  const lp = filePath.toLowerCase();
  return (
    lp.includes('controller') ||
    lp.includes('router') ||
    lp.includes('routes') ||
    lp.includes('handler') ||
    lp.includes('endpoint')
  );
}

// Extract HTTP method + path from diff
function extractEndpointsFromDiff(patch: string): string[] {
  const endpoints: string[] = [];

  const patterns = [
    /\+.*(?:router|app|router\.use)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /\+.*@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /\+.*route\s*=\s*['"`]([^'"`]+)['"`]/gi,
  ];

  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const method = match[1]?.toUpperCase() ?? 'ANY';
        const routePath = match[2] ?? match[1];
        if (routePath) {
          endpoints.push(`${method} ${routePath}`);
        }
      }
    }
  }

  return endpoints;
}

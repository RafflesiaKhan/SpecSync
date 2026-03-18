import * as core from '@actions/core';
import Anthropic from '@anthropic-ai/sdk';

// ─── Retry Wrapper ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

// Error codes that are worth retrying
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string };
  if (e.status === 429) return true;  // rate limited
  if (e.status === 529) return true;  // overloaded
  if (e.status != null && e.status >= 500) return true;  // server error
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function callClaudeWithRetry(
  client: Anthropic,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await client.messages.create(params);

      let text = '';
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
      }
      return text;
    } catch (err: unknown) {
      lastError = err;
      const e = err as { status?: number; message?: string };

      if (!isRetryable(err)) {
        core.error(`Claude API error (non-retryable, status ${e.status}): ${e.message}`);
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt; // 5s, 10s, 15s
        core.warning(
          `Claude API error (attempt ${attempt}/${MAX_RETRIES}, status ${e.status}): ${e.message}. Retrying in ${delay / 1000}s...`
        );
        await sleep(delay);
      }
    }
  }

  core.error(`Claude API failed after ${MAX_RETRIES} attempts`);
  throw lastError;
}

// ─── Robust JSON Parser ───────────────────────────────────────────────────────
// Three strategies, in order:
//   1. Direct parse
//   2. Strip markdown code fences, then parse
//   3. Brace-counting heuristic to find embedded JSON

export function parseJsonResponse<T>(raw: string, label: string): T | null {
  // Strategy 1: direct parse
  try {
    return JSON.parse(raw) as T;
  } catch { /* fall through */ }

  // Strategy 2: strip markdown code fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(stripped) as T;
  } catch { /* fall through */ }

  // Strategy 3: brace-counting — find first complete JSON object or array
  const startChar = raw.includes('[') && (!raw.includes('{') || raw.indexOf('[') < raw.indexOf('{'))
    ? '[' : '{';
  const endChar = startChar === '[' ? ']' : '}';

  const startIdx = raw.indexOf(startChar);
  if (startIdx !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < raw.length; i++) {
      const ch = raw[i];

      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === startChar) depth++;
      else if (ch === endChar) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(startIdx, i + 1)) as T;
          } catch { break; }
        }
      }
    }
  }

  core.error(`[${label}] Failed to parse JSON response using all 3 strategies. Raw response:\n${raw.slice(0, 500)}`);
  return null;
}

/**
 * SpecSync Wiki-to-Dispatch Relay
 * Cloudflare Worker — deploy once per organisation
 *
 * Receives GitHub Wiki webhook push events and translates them into
 * repository_dispatch events on the code repository, so SpecSync can
 * re-evaluate blocked PRs whenever a spec page is updated.
 *
 * Environment Variables (set in Cloudflare Workers settings):
 *   REPO_OWNER      — GitHub username or org (e.g. "acme-corp")
 *   REPO_NAME       — Repository name (e.g. "my-app")
 *   GITHUB_TOKEN    — Personal access token or GitHub App token with repo scope
 *   WEBHOOK_SECRET  — HMAC secret set in the GitHub Wiki webhook config
 */

export default {
  async fetch(request, env) {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Verify HMAC signature from GitHub webhook
    const signature = request.headers.get('X-Hub-Signature-256');
    if (env.WEBHOOK_SECRET) {
      const isValid = await verifySignature(request.clone(), env.WEBHOOK_SECRET, signature);
      if (!isValid) {
        return new Response('Forbidden — invalid signature', { status: 403 });
      }
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Bad Request — invalid JSON', { status: 400 });
    }

    // Extract changed wiki page paths from the push payload
    const changedFiles = payload.commits
      ?.flatMap(c => [...(c.added ?? []), ...(c.modified ?? [])])
      ?? [];

    if (changedFiles.length === 0) {
      return new Response('OK — no spec pages changed', { status: 200 });
    }

    const updatedBy = payload.pusher?.name ?? 'unknown';
    const wikiSha = payload.after ?? 'unknown';

    console.log(`Wiki update by ${updatedBy}: ${changedFiles.join(', ')}`);

    // Fire repository_dispatch on the code repo
    const dispatchResponse = await fetch(
      `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `token ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'SpecSync-Relay/1.0',
        },
        body: JSON.stringify({
          event_type: 'wiki-spec-updated',
          client_payload: {
            spec_pages: changedFiles,
            wiki_sha: wikiSha,
            updated_by: updatedBy,
          },
        }),
      }
    );

    if (!dispatchResponse.ok) {
      const errorText = await dispatchResponse.text();
      console.error(`GitHub dispatch failed: ${dispatchResponse.status} — ${errorText}`);
      return new Response(`Dispatch failed: ${errorText}`, {
        status: dispatchResponse.status,
      });
    }

    console.log(`Successfully dispatched wiki-spec-updated for ${changedFiles.join(', ')}`);

    return new Response(
      JSON.stringify({
        status: 'dispatched',
        spec_pages: changedFiles,
        updated_by: updatedBy,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};

/**
 * Verify GitHub webhook HMAC-SHA256 signature
 */
async function verifySignature(request, secret, signatureHeader) {
  if (!signatureHeader) return false;

  const body = await request.text();

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const computed = 'sha256=' + Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison to prevent timing attacks
  if (computed.length !== signatureHeader.length) return false;

  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }

  return mismatch === 0;
}

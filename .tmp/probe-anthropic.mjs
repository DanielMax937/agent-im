// Probe the Anthropic gateway exactly the way the bridge's claude runner does.
//
// Tests in order:
//   1. Plain HTTP GET on ANTHROPIC_BASE_URL to confirm reachability.
//   2. Raw POST /v1/messages via fetch — same wire format the SDK uses, lets us
//      see the literal HTTP status and body the gateway returns.
//   3. @anthropic-ai/sdk client (npm) — same library family the claude-code SDK
//      sits on top of; isolates "gateway broken" vs "SDK headers wrong".
//
// All three calls run with the EXACT env the user has in ~/.zshrc plus any
// proxy env that next-server normally inherits. Output is verbose so we can
// see headers, status, request id, and gateway error bodies.
import process from 'node:process';

const BASE = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/$/, '');
const KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
const MODEL = process.env.PROBE_MODEL || 'claude-3-5-sonnet-20241022';

if (!BASE || !KEY) {
  console.error('[probe] missing ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY/_AUTH_TOKEN in env; aborting.');
  process.exit(2);
}

function mask(v) {
  if (!v) return '(unset)';
  if (v.length <= 8) return '****';
  return v.slice(0, 6) + '…' + v.slice(-4) + ` (len=${v.length})`;
}

console.log('[probe] env snapshot');
console.log('  ANTHROPIC_BASE_URL  =', BASE);
console.log('  ANTHROPIC_API_KEY   =', mask(process.env.ANTHROPIC_API_KEY));
console.log('  ANTHROPIC_AUTH_TOKEN=', mask(process.env.ANTHROPIC_AUTH_TOKEN));
console.log('  HTTP_PROXY          =', process.env.HTTP_PROXY || '(unset)');
console.log('  HTTPS_PROXY         =', process.env.HTTPS_PROXY || '(unset)');
console.log('  NO_PROXY            =', process.env.NO_PROXY || '(unset)');
console.log('  model under test    =', MODEL);
console.log('');

// ── Test 1: reachability ───────────────────────────────────────────────────
console.log('── Test 1: GET', BASE, '(reachability) ──');
try {
  const r = await fetch(BASE, { method: 'GET' });
  const text = await r.text();
  console.log('  status:', r.status, r.statusText);
  console.log('  body  :', text.slice(0, 240).replace(/\n/g, ' '));
} catch (err) {
  console.log('  FAILED:', err?.message || err);
}
console.log('');

// ── Test 2: raw POST /v1/messages ──────────────────────────────────────────
console.log('── Test 2: POST', BASE + '/v1/messages', '──');
const body = {
  model: MODEL,
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
};
try {
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log('  status :', r.status, r.statusText);
  const reqId = r.headers.get('request-id') || r.headers.get('x-request-id');
  if (reqId) console.log('  req-id :', reqId);
  console.log('  body   :', text.slice(0, 800).replace(/\s+/g, ' '));
} catch (err) {
  console.log('  FAILED:', err?.message || err);
}
console.log('');

// ── Test 3: @anthropic-ai/claude-agent-sdk (the SDK the bridge uses) ───────
// This drives the SAME `query()` entrypoint that SDKLLMProvider invokes.
console.log('── Test 3: @anthropic-ai/claude-agent-sdk query() via', BASE, '──');
try {
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  const query = mod.query ?? mod.default?.query;
  if (typeof query !== 'function') {
    throw new Error(`query() not found on module exports: ${Object.keys(mod).join(', ')}`);
  }
  const it = query({
    prompt: 'Reply with exactly: PONG',
    options: {
      maxTurns: 1,
      // Force API mode (not CLI login) so we exercise ANTHROPIC_API_KEY+BASE_URL.
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || KEY,
        ANTHROPIC_BASE_URL: BASE,
      },
    },
  });
  let msgCount = 0;
  for await (const msg of it) {
    msgCount += 1;
    const preview =
      msg?.message?.content
        ? JSON.stringify(msg.message.content).slice(0, 200)
        : JSON.stringify(msg).slice(0, 240);
    console.log(`  msg#${msgCount} type=${msg?.type} ${preview}`);
    if (msgCount >= 6) break;
  }
  if (msgCount === 0) console.log('  (no messages yielded)');
} catch (err) {
  console.log('  FAILED:', err?.name, err?.message);
  if (err?.stack) console.log('  stack first line:', err.stack.split('\n')[1]?.trim());
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexImageGenerationProvider, parseImagesGenerationsRequest, type ImageGenerationProvider } from '../imagegen-provider';
import { createPlatformApp } from '../platform/app';
import { JsonPlatformStore } from '../platform/json-platform-store';

async function waitForImageJob(
  app: { handle(request: Request): Promise<Response> },
  jobId: string,
  predicate: (body: { status?: string }) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  let latest: Record<string, unknown> | null = null;
  while (Date.now() - started < timeoutMs) {
    const response = await app.handle(new Request(`http://local.test/v1/images/generations/jobs/${jobId}`));
    assert.equal(response.status, 200);
    latest = await response.json() as Record<string, unknown>;
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for image job ${jobId}; latest=${JSON.stringify(latest)}`);
}

describe('OpenAI images generations compatibility', () => {
  it('parses prompt and input image data URLs', () => {
    const parsed = parseImagesGenerationsRequest({
      prompt: 'turn the sketch into manga line art',
      n: 2,
      size: '1024x1536',
      input_image: 'data:image/png;base64,aGVsbG8=',
    });

    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.prompt, 'turn the sketch into manga line art');
    assert.equal(parsed.value.n, 2);
    assert.equal(parsed.value.inputImages.length, 1);
    assert.equal(parsed.value.inputImages[0]?.mime, 'image/png');
    assert.equal(parsed.value.inputImages[0]?.base64, 'aGVsbG8=');
  });

  it('rejects missing prompts', () => {
    const parsed = parseImagesGenerationsRequest({});
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.status, 400);
    assert.equal(parsed.message, 'prompt is required');
  });

  it('uses Codex CLI login mode for prompt-only generation without API keys', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-imagegen-test-'));
    const fakeCodex = path.join(tempDir, 'fake-codex.cjs');
    fs.writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'const prompt = fs.readFileSync(0, "utf8");',
      'if (args[0] !== "exec") process.exit(2);',
      'if (!args.includes("--json")) process.exit(5);',
      'const configIndex = args.indexOf("--config");',
      'if (configIndex === -1 || !args[configIndex + 1]?.includes("model_reasoning_effort")) process.exit(6);',
      'if (args.includes("--image")) process.exit(7);',
      'if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CTI_CODEX_API_KEY) {',
      '  console.error("unexpected api key env");',
      '  process.exit(3);',
      '}',
      'if (!prompt.startsWith("Generate an image now") || prompt.includes("blank helper image") || !prompt.includes("Codex CLI login mode") || !prompt.includes("Do not use OPENAI_API_KEY")) process.exit(4);',
      'const outDir = prompt.match(/Output directory: (.*)/)[1].trim();',
      'const manifestPath = prompt.match(/Manifest path: (.*)/)[1].trim();',
      'const count = Number(prompt.match(/Generate exactly (\\d+) image/)[1]);',
      'fs.mkdirSync(outDir, { recursive: true });',
      'const images = [];',
      'for (let i = 1; i <= count; i += 1) {',
      '  const filePath = path.join(outDir, `image-${i}.png`);',
      '  fs.writeFileSync(filePath, Buffer.from(`image-${i}`));',
      '  images.push({ path: filePath, revised_prompt: `revised-${i}` });',
      '}',
      'fs.writeFileSync(manifestPath, JSON.stringify({ images }));',
    ].join('\n'));
    fs.chmodSync(fakeCodex, 0o755);

    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-invalid-parent-key';
    try {
      const provider = new CodexImageGenerationProvider({
        codexExecutable: fakeCodex,
        promptOnlyTimeoutMs: 10_000,
      });
      const result = await provider.generate({
        model: 'codex-imagegen',
        prompt: '纯 prompt 漫画稿',
        n: 2,
        size: '1024x1024',
        responseFormat: 'b64_json',
        inputImages: [],
      });

      assert.equal(result.images.length, 2);
      assert.equal(result.images[0]?.mime, 'image/png');
      assert.equal(result.images[0]?.b64Json, Buffer.from('image-1').toString('base64'));
      assert.equal(result.images[1]?.b64Json, Buffer.from('image-2').toString('base64'));
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('can run prompt-only generation with the blank trigger when explicitly enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-imagegen-test-'));
    const fakeCodex = path.join(tempDir, 'fake-codex-trigger.cjs');
    fs.writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'const prompt = fs.readFileSync(0, "utf8");',
      'if (args[0] !== "exec") process.exit(2);',
      'if (args.includes("--json")) process.exit(3);',
      'if (args.includes("--config")) process.exit(4);',
      'const imageIndex = args.indexOf("--image");',
      'if (imageIndex === -1 || !args[imageIndex + 1] || !fs.existsSync(args[imageIndex + 1])) process.exit(5);',
      'if (!prompt.includes("blank helper image")) process.exit(6);',
      'function crc32(buf) {',
      '  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); return c >>> 0; });',
      '  let c = 0xffffffff;',
      '  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);',
      '  return (c ^ 0xffffffff) >>> 0;',
      '}',
      'const trigger = fs.readFileSync(args[imageIndex + 1]);',
      'let offset = 8;',
      'while (offset < trigger.length) {',
      '  const length = trigger.readUInt32BE(offset);',
      '  const type = trigger.subarray(offset + 4, offset + 8);',
      '  const data = trigger.subarray(offset + 8, offset + 8 + length);',
      '  const expected = trigger.readUInt32BE(offset + 8 + length);',
      '  const actual = crc32(Buffer.concat([type, data]));',
      '  if (expected !== actual) process.exit(8);',
      '  offset += 12 + length;',
      '}',
      'const outDir = prompt.match(/Output directory: (.*)/)[1].trim();',
      'const manifestPath = prompt.match(/Manifest path: (.*)/)[1].trim();',
      'fs.mkdirSync(outDir, { recursive: true });',
      'const filePath = path.join(outDir, "image-1.png");',
      'fs.writeFileSync(filePath, Buffer.from("trigger-prompt-image"));',
      'fs.writeFileSync(manifestPath, JSON.stringify({ images: [{ path: filePath }] }));',
    ].join('\n'));
    fs.chmodSync(fakeCodex, 0o755);

    const previous = process.env.CTI_IMAGEGEN_PROMPT_ONLY_BLANK_TRIGGER;
    process.env.CTI_IMAGEGEN_PROMPT_ONLY_BLANK_TRIGGER = 'true';
    try {
      const provider = new CodexImageGenerationProvider({
        codexExecutable: fakeCodex,
        promptOnlyTimeoutMs: 10_000,
      });
      const result = await provider.generate({
        model: 'codex-imagegen',
        prompt: '纯 prompt 漫画稿',
        n: 1,
        size: '1024x1024',
        responseFormat: 'b64_json',
        inputImages: [],
      });

      assert.equal(result.images.length, 1);
      assert.equal(result.images[0]?.b64Json, Buffer.from('trigger-prompt-image').toString('base64'));
    } finally {
      if (previous === undefined) delete process.env.CTI_IMAGEGEN_PROMPT_ONLY_BLANK_TRIGGER;
      else process.env.CTI_IMAGEGEN_PROMPT_ONLY_BLANK_TRIGGER = previous;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('passes input images to Codex CLI as image attachments', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-imagegen-test-'));
    const fakeCodex = path.join(tempDir, 'fake-codex-image.cjs');
    fs.writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'const prompt = fs.readFileSync(0, "utf8");',
      'if (args[0] !== "exec") process.exit(2);',
      'if (args.includes("--json")) process.exit(5);',
      'const imageIndex = args.indexOf("--image");',
      'if (imageIndex === -1 || !args[imageIndex + 1] || !fs.existsSync(args[imageIndex + 1])) process.exit(3);',
      'if (!prompt.includes("already attached to the initial prompt") || prompt.includes("call view_image")) process.exit(4);',
      'const outDir = prompt.match(/Output directory: (.*)/)[1].trim();',
      'const manifestPath = prompt.match(/Manifest path: (.*)/)[1].trim();',
      'fs.mkdirSync(outDir, { recursive: true });',
      'const filePath = path.join(outDir, "image-1.png");',
      'fs.writeFileSync(filePath, Buffer.from("attached-image"));',
      'fs.writeFileSync(manifestPath, JSON.stringify({ images: [{ path: filePath }] }));',
    ].join('\n'));
    fs.chmodSync(fakeCodex, 0o755);

    try {
      const provider = new CodexImageGenerationProvider({
        codexExecutable: fakeCodex,
        timeoutMs: 10_000,
      });
      const result = await provider.generate({
        model: 'codex-imagegen',
        prompt: '草图转漫画稿',
        n: 1,
        size: '1024x1536',
        responseFormat: 'b64_json',
        inputImages: [{ mime: 'image/png', base64: Buffer.from('fake-png').toString('base64') }],
      });

      assert.equal(result.images.length, 1);
      assert.equal(result.images[0]?.b64Json, Buffer.from('attached-image').toString('base64'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts Codex CLI failures', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-imagegen-test-'));
    const fakeCodex = path.join(tempDir, 'fake-codex-failure.cjs');
    fs.writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      'console.error("failure with sk-secretvalue123456789");',
      'process.exit(1);',
    ].join('\n'));
    fs.chmodSync(fakeCodex, 0o755);

    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-invalid-parent-key';
    try {
      const provider = new CodexImageGenerationProvider({
        codexExecutable: fakeCodex,
        promptOnlyTimeoutMs: 10_000,
      });

      await assert.rejects(
        provider.generate({
          model: 'codex-imagegen',
          prompt: '纯 prompt 漫画稿',
          n: 1,
          size: '1024x1024',
          responseFormat: 'b64_json',
          inputImages: [],
        }),
        (error) => {
          assert(error instanceof Error);
          assert.match(error.message, /codex imagegen exited with 1/);
          assert.doesNotMatch(error.message, /sk-secretvalue/);
          return true;
        },
      );
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns after Codex image_generation_end JSONL without waiting for process exit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-imagegen-test-'));
    const fakeCodex = path.join(tempDir, 'fake-codex-json.cjs');
    fs.writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'if (args[0] !== "exec") process.exit(2);',
      'fs.readFileSync(0, "utf8");',
      'process.stdout.write(JSON.stringify({',
      '  type: "event_msg",',
      '  payload: {',
      '    type: "image_generation_end",',
      '    call_id: "ig_test",',
      '    result: Buffer.from("json-image").toString("base64"),',
      '    revised_prompt: "json revised",',
      '  },',
      '}) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    fs.chmodSync(fakeCodex, 0o755);

    try {
      const provider = new CodexImageGenerationProvider({
        codexExecutable: fakeCodex,
        promptOnlyTimeoutMs: 10_000,
      });
      const start = Date.now();
      const result = await provider.generate({
        model: 'codex-imagegen',
        prompt: '纯 prompt 漫画稿',
        n: 1,
        size: '1024x1024',
        responseFormat: 'b64_json',
        inputImages: [],
      });

      assert(Date.now() - start < 5_000);
      assert.equal(result.images.length, 1);
      assert.equal(result.images[0]?.b64Json, Buffer.from('json-image').toString('base64'));
      assert.equal(result.images[0]?.revisedPrompt, 'json revised');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('collects image_generation_end from Codex session files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-imagegen-test-'));
    const fakeCodex = path.join(tempDir, 'fake-codex-session.cjs');
    fs.writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'fs.readFileSync(0, "utf8");',
      'const cwd = args[args.indexOf("-C") + 1];',
      'const now = new Date();',
      'const sessionDir = path.join(process.env.CODEX_HOME, "sessions", String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));',
      'fs.mkdirSync(sessionDir, { recursive: true });',
      'const sessionFile = path.join(sessionDir, "rollout-test.jsonl");',
      'fs.writeFileSync(sessionFile, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\\n");',
      'setTimeout(() => {',
      '  fs.appendFileSync(sessionFile, JSON.stringify({',
      '    type: "event_msg",',
      '    payload: {',
      '      type: "image_generation_end",',
      '      call_id: "ig_session_test",',
      '      result: Buffer.from("session-image").toString("base64"),',
      '      revised_prompt: "session revised",',
      '    },',
      '  }) + "\\n");',
      '}, 100);',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    fs.chmodSync(fakeCodex, 0o755);

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tempDir, 'codex-home');
    try {
      const provider = new CodexImageGenerationProvider({
        codexExecutable: fakeCodex,
        promptOnlyTimeoutMs: 10_000,
      });
      const result = await provider.generate({
        model: 'codex-imagegen',
        prompt: '纯 prompt 漫画稿',
        n: 1,
        size: '1024x1024',
        responseFormat: 'b64_json',
        inputImages: [],
      });

      assert.equal(result.images.length, 1);
      assert.equal(result.images[0]?.b64Json, Buffer.from('session-image').toString('base64'));
      assert.equal(result.images[0]?.revisedPrompt, 'session revised');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('collects session image events written immediately before Codex exits', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-imagegen-test-'));
    const fakeCodex = path.join(tempDir, 'fake-codex-session-exit.cjs');
    fs.writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'fs.readFileSync(0, "utf8");',
      'const cwd = args[args.indexOf("-C") + 1];',
      'const now = new Date();',
      'const sessionDir = path.join(process.env.CODEX_HOME, "sessions", String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));',
      'fs.mkdirSync(sessionDir, { recursive: true });',
      'const sessionFile = path.join(sessionDir, `rollout-exit-${process.pid}.jsonl`);',
      'fs.writeFileSync(sessionFile, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\\n");',
      'fs.appendFileSync(sessionFile, JSON.stringify({',
      '  type: "event_msg",',
      '  payload: {',
      '    type: "image_generation_end",',
      '    call_id: "ig_session_exit_test",',
      '    result: Buffer.from("session-exit-image").toString("base64"),',
      '    revised_prompt: "session exit revised",',
      '  },',
      '}) + "\\n");',
      'process.exit(0);',
    ].join('\n'));
    fs.chmodSync(fakeCodex, 0o755);

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tempDir, 'codex-home');
    try {
      const provider = new CodexImageGenerationProvider({
        codexExecutable: fakeCodex,
        promptOnlyTimeoutMs: 10_000,
      });
      const result = await provider.generate({
        model: 'codex-imagegen',
        prompt: '纯 prompt 漫画稿',
        n: 1,
        size: '1024x1024',
        responseFormat: 'b64_json',
        inputImages: [],
      });

      assert.equal(result.images.length, 1);
      assert.equal(result.images[0]?.b64Json, Buffer.from('session-exit-image').toString('base64'));
      assert.equal(result.images[0]?.revisedPrompt, 'session exit revised');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles POST /v1/images/generations with an injected provider', async () => {
    const provider: ImageGenerationProvider = {
      async generate(input) {
        return {
          images: Array.from({ length: input.n }, (_, index) => ({
            b64Json: Buffer.from(`image-${index + 1}`).toString('base64'),
            mime: 'image/png',
            revisedPrompt: `${input.prompt} #${index + 1}`,
          })),
        };
      },
    };

    const app = createPlatformApp({
      store: {} as never,
      workflowService: {} as never,
      instanceManager: { listRunningInstanceIds: () => [] } as never,
      imageGenerationProvider: provider,
    });

    const response = await app.handle(new Request('http://local.test/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({
        prompt: '角色草稿转漫画稿',
        n: 2,
        input_image: 'data:image/png;base64,aGVsbG8=',
      }),
    }));

    assert.equal(response.status, 200);
    const json = await response.json() as {
      object: string;
      data: Array<{ b64_json?: string; revised_prompt?: string }>;
    };
    assert.equal(json.object, 'image.generation');
    assert.equal(json.data.length, 2);
    assert.equal(json.data[0]?.b64_json, Buffer.from('image-1').toString('base64'));
    assert.equal(json.data[1]?.revised_prompt, '角色草稿转漫画稿 #2');
  });

  it('submits and polls async POST /v1/images/generations/jobs', async () => {
    const store = new JsonPlatformStore({ dbPath: ':memory:' });
    let release!: () => void;
    const provider: ImageGenerationProvider = {
      async generate(input) {
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          images: Array.from({ length: input.n }, (_, index) => ({
            b64Json: Buffer.from(`async-image-${index + 1}`).toString('base64'),
            mime: 'image/png',
            revisedPrompt: `${input.prompt} async #${index + 1}`,
          })),
        };
      },
    };

    const app = createPlatformApp({
      store,
      workflowService: {} as never,
      instanceManager: { listRunningInstanceIds: () => [] } as never,
      imageGenerationProvider: provider,
    });

    const submitResponse = await app.handle(new Request('http://local.test/v1/images/generations/jobs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: '异步角色草稿转漫画稿',
        n: 2,
        input_image: 'data:image/png;base64,aGVsbG8=',
      }),
    }));

    assert.equal(submitResponse.status, 202);
    const submitted = await submitResponse.json() as {
      id: string;
      job_id: string;
      jobid: string;
      object: string;
      status: string;
    };
    assert.equal(submitted.object, 'image.generation.job');
    assert.equal(submitted.status, 'queued');
    assert.equal(submitted.job_id, submitted.id);
    assert.equal(submitted.jobid, submitted.id);

    await waitForImageJob(app, submitted.job_id, (body) => body.status === 'running');
    release();
    const completed = await waitForImageJob(app, submitted.job_id, (body) => body.status === 'succeeded') as {
      status: string;
      result?: {
        object: string;
        data: Array<{ b64_json?: string; revised_prompt?: string }>;
      };
    };

    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.result?.object, 'image.generation');
    assert.equal(completed.result?.data.length, 2);
    assert.equal(completed.result?.data[0]?.b64_json, Buffer.from('async-image-1').toString('base64'));
    assert.equal(completed.result?.data[1]?.revised_prompt, '异步角色草稿转漫画稿 async #2');

    const persisted = store.getAsyncJob(submitted.job_id);
    assert.equal(persisted?.type, 'image.generation');
    assert.equal(persisted?.status, 'succeeded');
    assert.equal((persisted?.result as { object?: string } | undefined)?.object, 'image.generation');
    const artifacts = store.listAsyncJobArtifacts(submitted.job_id);
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0]?.type, 'image');
    assert.equal(artifacts[0]?.mimeType, 'image/png');
    assert.equal((artifacts[0]?.payload as { b64_json?: string } | undefined)?.b64_json, Buffer.from('async-image-1').toString('base64'));
  });

  it('reports async image generation failures through the job poll endpoint', async () => {
    const store = new JsonPlatformStore({ dbPath: ':memory:' });
    const provider: ImageGenerationProvider = {
      async generate() {
        throw new Error('provider exploded');
      },
    };

    const app = createPlatformApp({
      store,
      workflowService: {} as never,
      instanceManager: { listRunningInstanceIds: () => [] } as never,
      imageGenerationProvider: provider,
    });

    const submitResponse = await app.handle(new Request('http://local.test/v1/images/generations/jobs', {
      method: 'POST',
      body: JSON.stringify({ prompt: '失败测试' }),
    }));
    assert.equal(submitResponse.status, 202);
    const submitted = await submitResponse.json() as { job_id: string };

    const failed = await waitForImageJob(app, submitted.job_id, (body) => body.status === 'failed') as {
      status: string;
      error?: { message?: string; type?: string };
    };
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.message, 'provider exploded');
    assert.equal(failed.error?.type, 'upstream_error');

    const persisted = store.getAsyncJob(submitted.job_id);
    assert.equal(persisted?.type, 'image.generation');
    assert.equal(persisted?.status, 'failed');
    assert.equal(persisted?.error?.message, 'provider exploded');
  });

  it('returns 404 for unknown async image generation jobs', async () => {
    const store = new JsonPlatformStore({ dbPath: ':memory:' });
    const app = createPlatformApp({
      store,
      workflowService: {} as never,
      instanceManager: { listRunningInstanceIds: () => [] } as never,
      imageGenerationProvider: { async generate() { throw new Error('unused'); } },
    });

    const response = await app.handle(new Request('http://local.test/v1/images/generations/jobs/imgjob-missing'));
    assert.equal(response.status, 404);
    const json = await response.json() as { error?: { type?: string } };
    assert.equal(json.error?.type, 'not_found_error');
  });
});

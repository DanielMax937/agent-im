import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSubprocessEnvForRuntime } from './llm-provider';

export type ImageGenerationResponseFormat = 'b64_json' | 'url';

export interface ImagesGenerationsRequest {
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  response_format?: string;
  user?: string;
  input_image?: string;
  input_images?: string[];
  metadata?: Record<string, unknown>;
}

export interface ParsedImageInput {
  mime: string;
  base64: string;
}

export interface ParsedImagesGenerationsRequest {
  model: string;
  prompt: string;
  n: number;
  size: string;
  responseFormat: ImageGenerationResponseFormat;
  inputImages: ParsedImageInput[];
  user?: string;
  metadata?: Record<string, unknown>;
}

export interface GeneratedImageResult {
  b64Json: string;
  mime: string;
  revisedPrompt?: string;
}

export interface ImageGenerationProvider {
  generate(input: ParsedImagesGenerationsRequest): Promise<{
    images: GeneratedImageResult[];
  }>;
}

type ParseResult =
  | { ok: true; value: ParsedImagesGenerationsRequest }
  | { ok: false; status: number; message: string };

interface CodexImageManifest {
  images?: Array<{
    path?: string;
    revised_prompt?: string;
    revisedPrompt?: string;
  }>;
}

interface CodexJsonEvent {
  payload?: {
    type?: string;
    call_id?: string;
    id?: string;
    result?: string;
    saved_path?: string;
    revised_prompt?: string;
  };
}

const DEFAULT_IMAGEGEN_MODEL = 'codex-imagegen';
const DEFAULT_IMAGE_SIZE = '1024x1536';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROMPT_ONLY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PROMPT_ONLY_REASONING_EFFORT = 'low';
const PROMPT_ONLY_TRIGGER_IMAGE_NAME = 'prompt-only-trigger.png';
const PROMPT_ONLY_TRIGGER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_WRAPPER = path.join(SKILL_DIR, 'scripts', 'codex-wrapper.sh');

export function parseImageBase64DataUrl(url: string): ParsedImageInput | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  const mime = match[1]?.toLowerCase() || 'image/png';
  const base64 = match[2]?.trim();
  if (!base64) return null;
  return { mime, base64 };
}

export function parseImagesGenerationsRequest(body: ImagesGenerationsRequest): ParseResult {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return { ok: false, status: 400, message: 'prompt is required' };
  }

  const n = body.n === undefined ? 1 : body.n;
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    return { ok: false, status: 400, message: 'n must be an integer between 1 and 4' };
  }

  const size = typeof body.size === 'string' && body.size.trim() ? body.size.trim() : DEFAULT_IMAGE_SIZE;
  if (size !== 'auto' && !/^\d{2,5}x\d{2,5}$/.test(size)) {
    return { ok: false, status: 400, message: 'size must be auto or WIDTHxHEIGHT' };
  }

  const responseFormat = (body.response_format || 'b64_json').trim();
  if (responseFormat !== 'b64_json' && responseFormat !== 'url') {
    return { ok: false, status: 400, message: 'response_format must be b64_json or url' };
  }

  const rawImages = [
    ...(typeof body.input_image === 'string' && body.input_image.trim() ? [body.input_image] : []),
    ...(Array.isArray(body.input_images) ? body.input_images : []),
  ];
  const inputImages: ParsedImageInput[] = [];
  for (const raw of rawImages) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, status: 400, message: 'input_images must be base64 data URLs' };
    }
    const parsed = parseImageBase64DataUrl(raw);
    if (!parsed || !parsed.mime.startsWith('image/')) {
      return { ok: false, status: 400, message: 'input_images must be image data URLs' };
    }
    inputImages.push(parsed);
  }

  return {
    ok: true,
    value: {
      model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_IMAGEGEN_MODEL,
      prompt,
      n,
      size,
      responseFormat,
      inputImages,
      user: typeof body.user === 'string' && body.user.trim() ? body.user.trim() : undefined,
      metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? body.metadata
        : undefined,
    },
  };
}

function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.png';
  }
}

function mimeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

function readManifest(filePath: string): CodexImageManifest {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as CodexImageManifest;
}

function redactSecrets(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_*.-]{8,}/g, 'sk-***');
}

function compactProcessOutput(value: string): string {
  const redacted = redactSecrets(value).trim();
  if (!redacted) return '';
  const lines = redacted
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.length > 800 ? `${line.slice(0, 800)}...` : line);
  return lines.slice(-12).join('\n');
}

function commandFailureOutput(stdout: string, stderr: string): string {
  return compactProcessOutput(stderr || stdout) || 'no process output';
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function buildCodexWorkerPrompt(
  input: ParsedImagesGenerationsRequest,
  outputDir: string,
  manifestPath: string,
  inputPaths: string[],
  promptOnlyTriggerPath?: string,
): string {
  if (inputPaths.length === 0) {
    return [
      'Generate an image now by calling the built-in image generation tool as your first substantive action.',
      'Do not answer with text before the image generation call.',
      'Do not inspect files, read SKILL.md, run shell commands, or ask follow-up questions.',
      'Use Codex CLI login mode only. Do not use OPENAI_API_KEY, CODEX_API_KEY, or any API-key based image client.',
      ...(promptOnlyTriggerPath
        ? [
            'A blank helper image is attached only to keep Codex on the image generation route.',
            'Ignore the attached blank helper image completely; it is not a sketch, style reference, or visual constraint.',
          ]
        : []),
      'The HTTP harness captures image_generation_end events and writes API output files itself.',
      'After the image generation call completes, stop immediately.',
      '',
      `Generate exactly ${input.n} image(s).`,
      `Requested output size: ${input.size}.`,
      `Output directory: ${outputDir}`,
      `Manifest path: ${manifestPath}`,
      promptOnlyTriggerPath
        ? `Input reference/sketch image files: none\nAttached helper image: ${promptOnlyTriggerPath} (blank; ignore visually)`
        : 'Input reference/sketch image files: none',
      '',
      'Prompt to pass through to image generation:',
      input.prompt,
    ].join('\n');
  }

  const fastPathInstructions = inputPaths.length === 0
    ? [
        'Prompt-only fast path:',
        '- Your first substantive action must be the built-in image generation call.',
        '- Do not inspect this repository.',
        '- Do not run exploratory commands before the image generation call.',
        '- Do not use OPENAI_API_KEY or any API-key based image client; rely on the active Codex CLI login session.',
        '- The HTTP harness captures image_generation_end events and writes API output files itself.',
        '- After the image generation call completes, stop immediately. Do not copy files, write manifests, or run verification commands.',
        '',
      ]
    : [
        'Input-image fast path:',
        '- Do not read SKILL.md files, project files, repository contents, or documentation.',
        '- Do not run shell commands, metadata probes, image conversion commands, preview-generation commands, or view_image.',
        '- The input image files are already attached to the initial prompt; use the attached images directly as references.',
        '- Your first substantive action must be the built-in image generation call.',
        '- Do not use OPENAI_API_KEY or any API-key based image client; rely on the active Codex CLI login session.',
        '- The HTTP harness captures image_generation_end events and writes API output files itself.',
        '- After the image generation call completes, stop immediately. Do not copy files, write manifests, or run verification commands.',
        '',
      ];

  const fallbackManifestInstructions = inputPaths.length > 0
    ? [
        'Fallback only if no image_generation_end event is available to the harness:',
        '- Copy the final selected image files into the output directory.',
        '- Write a JSON manifest at the manifest path with this exact shape:',
        '{"images":[{"path":"/absolute/path/to/output/image-1.png","revised_prompt":"optional text"}]}',
        '',
      ]
    : [];

  return [
    'You are an image generation worker for an HTTP API.',
    '',
    'Use Codex CLI login mode and the built-in image_gen tool to generate bitmap images.',
    'Do not edit this repository. Do not write outside the provided output directory except for normal Codex imagegen scratch files.',
    '',
    ...fastPathInstructions,
    `Generate exactly ${input.n} image(s).`,
    `Requested output size: ${input.size}.`,
    `Output directory: ${outputDir}`,
    `Manifest path: ${manifestPath}`,
    inputPaths.length > 0
      ? `Input reference/sketch image files:\n${inputPaths.map((p, i) => `- Image ${i + 1}: ${p}`).join('\n')}`
      : 'Input reference/sketch image files: none',
    '',
    ...fallbackManifestInstructions,
    '',
    'Prompt to pass through to imagegen:',
    input.prompt,
  ].join('\n');
}

function readGeneratedImages(outputDir: string, entries: Array<{ path?: string; revised_prompt?: string; revisedPrompt?: string }>, limit: number): GeneratedImageResult[] {
  const images: GeneratedImageResult[] = [];
  for (const entry of entries.slice(0, limit)) {
    if (!entry.path) continue;
    const resolved = path.resolve(entry.path);
    if (!isInside(outputDir, resolved)) {
      throw new Error(`imagegen output path is outside output directory: ${resolved}`);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`imagegen output file not found: ${resolved}`);
    }
    images.push({
      b64Json: fs.readFileSync(resolved).toString('base64'),
      mime: mimeForPath(resolved),
      revisedPrompt: entry.revised_prompt || entry.revisedPrompt,
    });
  }

  if (images.length === 0) {
    throw new Error('imagegen produced no readable images');
  }
  return images;
}

function manifestHasReadableImages(manifestPath: string, outputDir: string, limit: number): boolean {
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = readManifest(manifestPath);
    if (!Array.isArray(manifest.images) || manifest.images.length === 0) return false;
    return readGeneratedImages(outputDir, manifest.images, limit).length >= limit;
  } catch {
    return false;
  }
}

function appendBounded(current: string, chunk: string, maxLength = 200_000): string {
  const next = current + chunk;
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

function createCodexJsonImageCollector(input: ParsedImagesGenerationsRequest, outputDir: string, manifestPath: string): (chunk: string) => void {
  let buffer = '';
  const seen = new Set<string>();
  const images: Array<{ path: string; revised_prompt?: string }> = [];

  const writeManifest = () => {
    fs.writeFileSync(manifestPath, JSON.stringify({ images }));
  };

  const collectEvent = (event: CodexJsonEvent) => {
    const payload = event.payload;
    if (!payload || payload.type !== 'image_generation_end') return;
    if (images.length >= input.n) return;

    const id = payload.call_id || payload.id || payload.saved_path || `${images.length + 1}`;
    if (seen.has(id)) return;

    const outputPath = path.join(outputDir, `image-${images.length + 1}.png`);
    if (typeof payload.result === 'string' && payload.result.trim()) {
      fs.writeFileSync(outputPath, Buffer.from(payload.result, 'base64'));
    } else if (typeof payload.saved_path === 'string' && payload.saved_path.trim()) {
      fs.copyFileSync(payload.saved_path, outputPath);
    } else {
      return;
    }

    seen.add(id);
    images.push({
      path: outputPath,
      revised_prompt: payload.revised_prompt,
    });
    writeManifest();
  };

  return (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        collectEvent(JSON.parse(line) as CodexJsonEvent);
      } catch {
        // Codex JSONL can include non-JSON diagnostics on some failures.
      }
    }
  };
}

function formatSessionDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return path.join(year, month, day);
}

function codexSessionsRoot(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

function candidateSessionDirs(): string[] {
  const now = Date.now();
  return [new Date(now), new Date(now - 24 * 60 * 60 * 1000)]
    .map((date) => path.join(codexSessionsRoot(), formatSessionDate(date)))
    .filter((dir, index, dirs) => dirs.indexOf(dir) === index && fs.existsSync(dir));
}

function readFirstJsonLine(filePath: string): unknown {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total < 2 * 1024 * 1024) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (bytesRead <= 0) break;
      const slice = Buffer.from(chunk.subarray(0, bytesRead));
      const newline = slice.indexOf(10);
      if (newline !== -1) {
        chunks.push(slice.subarray(0, newline));
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      chunks.push(slice);
      total += bytesRead;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function findCodexSessionFileForCwd(cwd: string, startedAtMs: number): string | null {
  const resolvedCwd = path.resolve(cwd);
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const dir of candidateSessionDirs()) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs + 60_000 < startedAtMs) continue;
      candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    try {
      const first = readFirstJsonLine(candidate.filePath) as { payload?: { cwd?: string } } | null;
      if (first?.payload?.cwd && path.resolve(first.payload.cwd) === resolvedCwd) {
        return candidate.filePath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function createCodexSessionImageCollector(root: string, input: ParsedImagesGenerationsRequest, outputDir: string, manifestPath: string): () => void {
  const collectJsonLine = createCodexJsonImageCollector(input, outputDir, manifestPath);
  const startedAtMs = Date.now();
  let sessionFile: string | null = null;
  let offset = 0;
  let buffer = '';

  return () => {
    if (!sessionFile) {
      sessionFile = findCodexSessionFileForCwd(root, startedAtMs);
      if (!sessionFile) return;
    }

    const stat = fs.statSync(sessionFile);
    if (stat.size <= offset) return;

    const fd = fs.openSync(sessionFile, 'r');
    try {
      const bytesToRead = stat.size - offset;
      const chunk = Buffer.alloc(bytesToRead);
      fs.readSync(fd, chunk, 0, bytesToRead, offset);
      offset = stat.size;
      buffer += chunk.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }

    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      collectJsonLine(line);
    }
  };
}

async function collectSessionImagesAfterExit(collectSessionImages: () => void, manifestPath: string, outputDir: string, limit: number): Promise<void> {
  collectSessionImages();
  if (manifestHasReadableImages(manifestPath, outputDir, limit)) return;
  await new Promise((resolve) => setTimeout(resolve, 300));
  collectSessionImages();
}

function buildCodexLoginEnv(): NodeJS.ProcessEnv {
  const env = buildSubprocessEnvForRuntime({ runtime: 'codex', useLogin: true });
  env.CTI_CODEX_USE_LOGIN = 'true';
  delete env.CTI_CODEX_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CTI_CODEX_BASE_URL;
  return env;
}

async function runCommand(command: string, args: string[], stdin: string, timeoutMs: number, env: NodeJS.ProcessEnv, isReady?: () => boolean, onStdoutData?: (chunk: string) => void): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (value: {
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(readyTimer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(readyTimer);
      child.kill('SIGTERM');
      reject(new Error(`image generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const readyTimer = setInterval(() => {
      if (!isReady || settled) return;
      let ready = false;
      try {
        ready = isReady();
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(readyTimer);
        child.kill('SIGTERM');
        reject(err);
        return;
      }
      if (!ready) return;
      child.kill('SIGTERM');
      settle({ code: 0, signal: null, stdout, stderr });
    }, 1000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
      try {
        onStdoutData?.(chunk);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(readyTimer);
        child.kill('SIGTERM');
        reject(err);
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(readyTimer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      settle({ code, signal, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export class CodexImageGenerationProvider implements ImageGenerationProvider {
  constructor(private readonly options: {
    codexExecutable?: string;
    timeoutMs?: number;
    promptOnlyTimeoutMs?: number;
  } = {}) {}

  async generate(input: ParsedImagesGenerationsRequest): Promise<{ images: GeneratedImageResult[] }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-imagegen-'));
    const inputDir = path.join(root, 'input');
    const outputDir = path.join(root, 'output');
    const manifestPath = path.join(root, 'manifest.json');
    const finalMessagePath = path.join(root, 'final-message.txt');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const inputPaths = input.inputImages.map((image, index) => {
      const filePath = path.join(inputDir, `input-${index + 1}${extensionForMime(image.mime)}`);
      fs.writeFileSync(filePath, Buffer.from(image.base64, 'base64'));
      return filePath;
    });
    const promptOnlyTriggerPath = inputPaths.length === 0 && process.env.CTI_IMAGEGEN_PROMPT_ONLY_BLANK_TRIGGER === 'true'
      ? path.join(inputDir, PROMPT_ONLY_TRIGGER_IMAGE_NAME)
      : undefined;
    if (promptOnlyTriggerPath) {
      fs.writeFileSync(promptOnlyTriggerPath, Buffer.from(PROMPT_ONLY_TRIGGER_PNG_BASE64, 'base64'));
    }
    const codexImagePaths = promptOnlyTriggerPath ? [promptOnlyTriggerPath] : inputPaths;

    const codexExecutable =
      this.options.codexExecutable ||
      process.env.CTI_IMAGEGEN_CODEX_EXECUTABLE ||
      process.env.CTI_CODEX_EXECUTABLE ||
      process.env.CODEX_EXECUTABLE ||
      CODEX_WRAPPER;
    const timeoutMs = inputPaths.length === 0
      ? this.options.promptOnlyTimeoutMs ?? Number(process.env.CTI_IMAGEGEN_PROMPT_ONLY_TIMEOUT_MS || DEFAULT_PROMPT_ONLY_TIMEOUT_MS)
      : this.options.timeoutMs ?? Number(process.env.CTI_IMAGEGEN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const workerPrompt = buildCodexWorkerPrompt(input, outputDir, manifestPath, inputPaths, promptOnlyTriggerPath);
    const promptOnlyReasoningEffort =
      process.env.CTI_IMAGEGEN_PROMPT_ONLY_REASONING_EFFORT || DEFAULT_PROMPT_ONLY_REASONING_EFFORT;
    const useDirectPromptOnly = inputPaths.length === 0 && !promptOnlyTriggerPath;
    const args = [
      'exec',
      ...(useDirectPromptOnly
        ? ['--json', '--config', `model_reasoning_effort="${promptOnlyReasoningEffort}"`]
        : []),
      ...codexImagePaths.flatMap((inputPath) => ['--image', inputPath]),
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-C',
      root,
      '-o',
      finalMessagePath,
      '-',
    ];

    const collectSessionImages = createCodexSessionImageCollector(root, input, outputDir, manifestPath);
    const collectStdoutImages = createCodexJsonImageCollector(input, outputDir, manifestPath);
    const result = await runCommand(
      codexExecutable,
      args,
      workerPrompt,
      timeoutMs,
      buildCodexLoginEnv(),
      () => {
        collectSessionImages();
        return manifestHasReadableImages(manifestPath, outputDir, input.n);
      },
      collectStdoutImages,
    );
    if (result.code !== 0) {
      throw new Error(`codex imagegen exited with ${result.code ?? result.signal ?? 'unknown'}: ${commandFailureOutput(result.stdout, result.stderr)}`);
    }
    await collectSessionImagesAfterExit(collectSessionImages, manifestPath, outputDir, input.n);
    if (!fs.existsSync(manifestPath)) {
      const finalMessage = fs.existsSync(finalMessagePath) ? fs.readFileSync(finalMessagePath, 'utf8') : '';
      throw new Error(`codex imagegen did not write manifest.json. Last message: ${compactProcessOutput(finalMessage || result.stdout || result.stderr) || 'no process output'}`);
    }

    const manifest = readManifest(manifestPath);
    if (!Array.isArray(manifest.images) || manifest.images.length === 0) {
      throw new Error('codex imagegen manifest did not include images');
    }

    const images = readGeneratedImages(outputDir, manifest.images, input.n);
    if (images.length < input.n) {
      throw new Error(`codex imagegen produced ${images.length} image(s), expected ${input.n}`);
    }

    return { images };
  }
}

let cachedProvider: ImageGenerationProvider | null = null;

export function resolveImageGenerationProvider(): ImageGenerationProvider {
  if (!cachedProvider) {
    cachedProvider = new CodexImageGenerationProvider();
  }
  return cachedProvider;
}

export function makeImageGenerationId(): string {
  return `imggen-${crypto.randomUUID()}`;
}

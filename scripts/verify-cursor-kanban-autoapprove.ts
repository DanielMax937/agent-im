/**
 * Spawns the real `agent` CLI against a fresh temp directory (workspace), using the same
 * argv order as `CursorProvider` (after --workspace: --yolo --trust -f when autoApprove).
 *
 * Run:
 *   npx tsx scripts/verify-cursor-kanban-autoapprove.ts
 *
 * Requires `agent` on PATH (same as bridge). May still exit non-zero if auth/API fails;
 * the important signal is stderr: with trust flags, "Workspace Trust Required" should not appear.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadKanbanPlatformConfig,
  normalizeRunnersWithProcessEnvOverride,
  type RunnerConfig,
} from '../src/config';

const TIMEOUT_MS = 60_000;
const PROMPT = 'Reply with the single word: ok';

function buildArgs(opts: {
  workspace: string;
  model: string;
  autoApproveFlags: boolean;
}): string[] {
  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--workspace',
    opts.workspace,
  ];
  if (opts.model && !opts.model.startsWith('claude')) {
    args.push('--model', opts.model);
  }
  if (opts.autoApproveFlags) {
    args.push('--yolo', '--trust', '-f');
  }
  args.push('--', PROMPT);
  return args;
}

function runAgent(args: string[], cwd: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('agent', args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      reject(new Error(`timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stderr, stdout });
    });
  });
}

function hasWorkspaceTrustMessage(s: string): boolean {
  return /Workspace Trust Required/i.test(s);
}

async function main(): Promise<void> {
  const cfg = loadKanbanPlatformConfig();
  const runners = normalizeRunnersWithProcessEnvOverride(cfg);
  const cursor = runners.find((r) => r.id === 'cursor') as RunnerConfig | undefined;

  if (!cursor) {
    console.error('No runner id "cursor" in kanban config.');
    process.exit(1);
  }

  const model = cursor.defaultModel ?? process.env.CTI_CURSOR_MODEL ?? 'composer-2-fast';
  const runnerAutoApprove = cursor.autoApprove === true;

  // Prefer /tmp on Unix so behavior matches Kanban worktrees like /tmp/wt-* (not only $TMPDIR).
  const base =
    process.platform !== 'win32' && fs.existsSync('/tmp')
      ? '/tmp'
      : os.tmpdir();
  const workspace = mkdtempSync(path.join(base, 'cursor-ws-verify-'));
  fs.writeFileSync(path.join(workspace, 'README.md'), '# probe\n', 'utf8');

  console.log('Kanban config: ~/.claude-to-im/kanban/config.env');
  console.log('Runner `cursor`.autoApprove:', cursor.autoApprove, '→', runnerAutoApprove);
  console.log('Temp workspace:', workspace);
  console.log('');

  const argsWithTrust = buildArgs({ workspace, model, autoApproveFlags: true });
  const argsWithoutTrust = buildArgs({ workspace, model, autoApproveFlags: false });

  console.log('A) With --yolo --trust -f (matches CursorProvider when autoApprove):');
  console.log('   ', ['agent', ...argsWithTrust].join(' '));
  console.log('');

  try {
    const a = await runAgent(argsWithTrust, workspace);
    console.log('   exit code:', a.code);
    const trustA = hasWorkspaceTrustMessage(a.stderr);
    console.log('   stderr has "Workspace Trust Required"?', trustA ? 'YES (bad)' : 'no (good for trust)');
    if (a.stderr.trim()) {
      console.log('   stderr (first 800 chars):\n', a.stderr.slice(0, 800));
    }
  } catch (e) {
    console.error('   spawn/run failed:', e);
  }

  console.log('');
  console.log('B) Without --yolo/--trust/-f (control: often triggers Workspace Trust on unknown dirs):');
  console.log('   ', ['agent', ...argsWithoutTrust].join(' '));
  console.log('');

  try {
    const b = await runAgent(argsWithoutTrust, workspace);
    console.log('   exit code:', b.code);
    const trustB = hasWorkspaceTrustMessage(b.stderr);
    console.log('   stderr has "Workspace Trust Required"?', trustB ? 'yes (expected for control)' : 'no');
    if (b.stderr.trim()) {
      console.log('   stderr (first 800 chars):\n', b.stderr.slice(0, 800));
    }
  } catch (e) {
    console.error('   spawn/run failed:', e);
  }

  console.log('');
  console.log('Interpretation:');
  console.log('- If A has no Workspace Trust line but B does, trust flags fix the headless /tmp workspace case.');
  console.log('- If both fail with auth/network, check stderr for other errors (still compare A vs B).');
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* leave for manual inspect */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

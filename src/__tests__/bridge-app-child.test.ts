import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveDaemonEntry } from '../lib/bridge-app-child';

describe('resolveDaemonEntry', () => {
  let projectRoot: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    prevRoot = process.env.CTI_PROJECT_ROOT;
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-daemon-entry-'));
    process.env.CTI_PROJECT_ROOT = projectRoot;
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'tsx', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'main.ts'), 'export {};\n', 'utf-8');
    fs.writeFileSync(
      path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'export {};\n',
      'utf-8',
    );
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CTI_PROJECT_ROOT;
    else process.env.CTI_PROJECT_ROOT = prevRoot;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('uses bundled daemon when dist is fresh', () => {
    const bundled = path.join(projectRoot, 'dist', 'daemon.mjs');
    fs.writeFileSync(bundled, 'export {};\n', 'utf-8');

    const entry = resolveDaemonEntry();

    assert.deepEqual(entry, {
      command: process.execPath,
      args: [bundled],
    });
  });

  it('falls back to tsx when src is newer than dist', async () => {
    const bundled = path.join(projectRoot, 'dist', 'daemon.mjs');
    const mainTs = path.join(projectRoot, 'src', 'main.ts');
    const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    fs.writeFileSync(bundled, 'export {};\n', 'utf-8');
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(mainTs, 'export const fresh = true;\n', 'utf-8');

    const entry = resolveDaemonEntry();

    assert.deepEqual(entry, {
      command: process.execPath,
      args: [tsxCli, mainTs],
    });
  });
});

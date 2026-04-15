import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ensureBootstrappedWorkspace, parseBootstrapProjectWorkflowInput } from '../platform/project-bootstrap';
import type { RunnerConfig } from '../config-shared';

const RUNNERS: RunnerConfig[] = [
  { id: 'rt-4', runtime: 'codex', label: 'rt-4', defaultMode: 'code' },
];

describe('project-bootstrap', () => {
  it('initializes a git repository with an initial commit for a new local project', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bootstrap-git-'));
    fs.writeFileSync(path.join(localPath, 'package.json'), JSON.stringify({ name: 'bootstrap-test' }), 'utf8');

    const prepared = parseBootstrapProjectWorkflowInput(
      {
        requirement: 'Build a jackpot web app.',
        projectName: 'Bootstrap Test',
        repository: {
          localPath,
          baseBranch: 'main',
        },
        deployment: {
          enabled: false,
        },
        scaffoldProject: false,
        createGitHubRepo: false,
        assignTasks: false,
      },
      RUNNERS,
    );

    const workspace = await ensureBootstrappedWorkspace(prepared);

    assert.equal(workspace.localPath, localPath);
    assert.equal(fs.existsSync(path.join(localPath, '.git')), true);
    assert.equal(fs.existsSync(path.join(localPath, '.git', 'HEAD')), true);
  });
});

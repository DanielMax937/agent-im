import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { allocateNextIssueId, resolveIssueIdPrefix } from '../platform/issue-id';
import type { Project } from '../platform/types';

function project(partial: Partial<Project> & Pick<Project, 'id'>): Project {
  const now = new Date().toISOString();
  return {
    name: partial.name ?? 'P',
    repository: partial.repository ?? {
      remoteUrl: 'x',
      localPath: '/x',
      baseBranch: 'main',
      sprintBranchPrefix: 'f/',
      taskBranchPrefix: 'd/',
      scmProvider: 'github',
      scmProject: 'a/b',
    },
    agents: partial.agents ?? [],
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    ...partial,
  };
}

describe('issue-id', () => {
  it('resolveIssueIdPrefix uses explicit prefix', () => {
    assert.equal(
      resolveIssueIdPrefix(project({ id: 'x', issueIdPrefix: 'foo-bar' })),
      'FOOBAR',
    );
  });

  it('resolveIssueIdPrefix uses first segment of project id', () => {
    assert.equal(resolveIssueIdPrefix(project({ id: 'demo-app' })), 'DEMO');
  });

  it('allocateNextIssueId increments within project', () => {
    const next = allocateNextIssueId(
      'p1',
      'DEMO',
      () => ['DEMO-1', 'DEMO-3', 'OTHER-1'],
    );
    assert.equal(next, 'DEMO-4');
  });
});

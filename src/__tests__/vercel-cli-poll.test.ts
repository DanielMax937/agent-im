import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendVercelProtectionBypassQuery,
  pickLatestReadyDeploymentForGitRef,
  type VercelDeploymentSummary,
} from '../platform/vercel-cli';

describe('pickLatestReadyDeploymentForGitRef', () => {
  it('returns undefined when no deployment matches ref', () => {
    const list: VercelDeploymentSummary[] = [
      {
        id: 'a',
        readyState: 'READY',
        target: 'production',
        meta: { githubCommitRef: 'main' },
        createdAt: 100,
      },
    ];
    assert.equal(pickLatestReadyDeploymentForGitRef(list, 'feature/x'), undefined);
  });

  it('prefers preview (target null) READY deployment on the sprint branch over production on main', () => {
    const list: VercelDeploymentSummary[] = [
      {
        id: 'prod-main',
        url: 'main.example.vercel.app',
        readyState: 'READY',
        target: 'production',
        meta: { githubCommitRef: 'main', githubCommitSha: 'aaa' },
        createdAt: 200,
      },
      {
        id: 'preview-sprint',
        url: 'sprint.example.vercel.app',
        readyState: 'READY',
        target: null,
        meta: { githubCommitRef: 'feature/mvp-sprint', githubCommitSha: 'bbb' },
        createdAt: 100,
      },
    ];
    const picked = pickLatestReadyDeploymentForGitRef(list, 'feature/mvp-sprint');
    assert.equal(picked?.id, 'preview-sprint');
    assert.equal(picked?.meta?.githubCommitSha, 'bbb');
  });

  it('picks newest READY by createdAt when multiple match the ref', () => {
    const list: VercelDeploymentSummary[] = [
      {
        id: 'older',
        readyState: 'READY',
        target: null,
        meta: { githubCommitRef: 'feature/mvp-sprint' },
        createdAt: 1,
      },
      {
        id: 'newer',
        readyState: 'READY',
        target: null,
        meta: { githubCommitRef: 'feature/mvp-sprint' },
        createdAt: 99,
      },
    ];
    assert.equal(pickLatestReadyDeploymentForGitRef(list, 'feature/mvp-sprint')?.id, 'newer');
  });

  it('appendVercelProtectionBypassQuery adds bypass params when token arg provided', () => {
    const out = appendVercelProtectionBypassQuery(
      'https://example.vercel.app/path',
      'secret-token-xyz',
    );
    const u = new URL(out);
    assert.equal(u.searchParams.get('x-vercel-set-bypass-cookie'), 'true');
    assert.equal(u.searchParams.get('x-vercel-protection-bypass'), 'secret-token-xyz');
    assert.match(out, /^https:\/\/example\.vercel\.app\/path\?/);
  });

  it('appendVercelProtectionBypassQuery returns original when token empty', () => {
    assert.equal(
      appendVercelProtectionBypassQuery('https://a.vercel.app/', ''),
      'https://a.vercel.app/',
    );
  });

  it('ignores non-READY deployments', () => {
    const list: VercelDeploymentSummary[] = [
      {
        id: 'building',
        readyState: 'BUILDING',
        meta: { githubCommitRef: 'feature/mvp-sprint' },
        createdAt: 999,
      },
      {
        id: 'ready',
        readyState: 'READY',
        meta: { githubCommitRef: 'feature/mvp-sprint' },
        createdAt: 1,
      },
    ];
    assert.equal(pickLatestReadyDeploymentForGitRef(list, 'feature/mvp-sprint')?.id, 'ready');
  });
});

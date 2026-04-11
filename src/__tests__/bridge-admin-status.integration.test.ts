/**
 * Integration tests: real directories under a temp CTI_BASE (no mocked bridge state).
 * Mirrors admin flow: list bridges → change one home on disk → assert per-slug status stays isolated.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getCtiBaseDir,
  getCtiBotDisplayName,
  getCtiHomeForBridgeSlug,
  invalidateBridgePathsCache,
  listBridgeSlugs,
} from '../config';
import { readBridgeDaemonDiskStatus } from '../lib/bridge-daemon-status';
import { getBridgeStatusForApi } from '../lib/bridge-app-child';

const MIN_CONFIG = 'CTI_RUNTIME=claude\n';

type EnvSnapshot = {
  CTI_HOME?: string;
  CTI_BASE?: string;
  CTI_BOT_NAME?: string;
};

function saveEnv(): EnvSnapshot {
  return {
    CTI_HOME: process.env.CTI_HOME,
    CTI_BASE: process.env.CTI_BASE,
    CTI_BOT_NAME: process.env.CTI_BOT_NAME,
  };
}

function restoreEnv(s: EnvSnapshot): void {
  if (s.CTI_HOME === undefined) delete process.env.CTI_HOME;
  else process.env.CTI_HOME = s.CTI_HOME;
  if (s.CTI_BASE === undefined) delete process.env.CTI_BASE;
  else process.env.CTI_BASE = s.CTI_BASE;
  if (s.CTI_BOT_NAME === undefined) delete process.env.CTI_BOT_NAME;
  else process.env.CTI_BOT_NAME = s.CTI_BOT_NAME;
}

/** Same bridge list as GET /api/local-config (discovered ∪ active). */
function bridgeSlugsForAdmin(): string[] {
  const activeBotName = getCtiBotDisplayName();
  const discovered = listBridgeSlugs();
  return [...new Set([...discovered, activeBotName])].sort((a, b) => a.localeCompare(b));
}

function daemonStatusBySlug(): Record<string, ReturnType<typeof readBridgeDaemonDiskStatus>> {
  const out: Record<string, ReturnType<typeof readBridgeDaemonDiskStatus>> = {};
  for (const slug of bridgeSlugsForAdmin()) {
    const home = getCtiHomeForBridgeSlug(slug);
    out[slug] = readBridgeDaemonDiskStatus(home);
  }
  return out;
}

function embeddedStatusBySlug(): Record<string, ReturnType<typeof getBridgeStatusForApi>> {
  const out: Record<string, ReturnType<typeof getBridgeStatusForApi>> = {};
  for (const slug of bridgeSlugsForAdmin()) {
    const home = getCtiHomeForBridgeSlug(slug);
    out[slug] = getBridgeStatusForApi(home);
  }
  return out;
}

function writeRunningStatusJson(home: string, body: Record<string, unknown>): void {
  const rt = path.join(home, 'runtime');
  fs.mkdirSync(rt, { recursive: true });
  const p = path.join(rt, 'status.json');
  fs.writeFileSync(p, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
}

function ensureBridgeHome(slug: string, base: string): string {
  const home = path.join(base, slug);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.env'), MIN_CONFIG, 'utf-8');
  return home;
}

describe('bridge admin status (real dirs under CTI_BASE)', () => {
  let saved: EnvSnapshot;
  let base: string;

  beforeEach(() => {
    saved = saveEnv();
    delete process.env.CTI_HOME;
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-admin-'));
    process.env.CTI_BASE = base;
    delete process.env.CTI_BOT_NAME;
    invalidateBridgePathsCache();
  });

  afterEach(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    restoreEnv(saved);
    invalidateBridgePathsCache();
  });

  it('lists all bridges, changes one runtime/status.json, other bridge daemon + embedded status unchanged', () => {
    ensureBridgeHome('bridge-alpha', base);
    ensureBridgeHome('bridge-beta', base);
    fs.writeFileSync(path.join(base, '.active_bridge'), 'bridge-alpha\n', 'utf-8');
    process.env.CTI_BOT_NAME = 'bridge-alpha';
    invalidateBridgePathsCache();

    assert.equal(getCtiBaseDir(), base);

    const listed = bridgeSlugsForAdmin();
    assert.deepEqual(listed, ['bridge-alpha', 'bridge-beta']);

    const homeA = getCtiHomeForBridgeSlug('bridge-alpha');
    const homeB = getCtiHomeForBridgeSlug('bridge-beta');
    assert.notEqual(path.resolve(homeA), path.resolve(homeB));

    const before = daemonStatusBySlug();
    const beforeEmb = embeddedStatusBySlug();
    for (const slug of listed) {
      assert.equal(before[slug].effectiveRunning, false, `pre: ${slug} should not look running`);
      assert.equal(beforeEmb[slug].running, false, `pre embedded: ${slug}`);
    }

    // Change only bridge-beta: mark running with no pid (disk says running)
    writeRunningStatusJson(homeB, { running: true, startedAt: new Date().toISOString() });

    const after = daemonStatusBySlug();
    const afterEmb = embeddedStatusBySlug();

    assert.equal(after['bridge-alpha'].effectiveRunning, false, 'alpha must stay stopped');
    assert.equal(after['bridge-alpha'].statusFilePresent, false, 'alpha has no status file');
    assert.equal(after['bridge-beta'].effectiveRunning, true, 'beta should show running from its own status.json');
    assert.equal(after['bridge-beta'].statusFilePresent, true);

    assert.equal(afterEmb['bridge-alpha'].running, false, 'alpha embedded still not running');
    assert.equal(afterEmb['bridge-beta'].running, true, 'beta embedded follows disk');
  });

  it('with CTI_HOME set, changing active bridge status does not flip the other slug under CTI_BASE', () => {
    ensureBridgeHome('bridge-alpha', base);
    ensureBridgeHome('bridge-beta', base);

    const homeAlpha = path.join(base, 'bridge-alpha');
    const homeBeta = path.join(base, 'bridge-beta');

    process.env.CTI_HOME = homeAlpha;
    delete process.env.CTI_BOT_NAME;
    invalidateBridgePathsCache();

    assert.equal(getCtiBotDisplayName(), 'bridge-alpha');

    const listed = bridgeSlugsForAdmin();
    assert.ok(listed.includes('bridge-alpha'));
    assert.ok(listed.includes('bridge-beta'));

    assert.equal(path.resolve(getCtiHomeForBridgeSlug('bridge-alpha')), path.resolve(homeAlpha));
    assert.equal(path.resolve(getCtiHomeForBridgeSlug('bridge-beta')), path.resolve(homeBeta));

    const before = daemonStatusBySlug();
    for (const slug of listed) {
      assert.equal(before[slug].effectiveRunning, false, `pre: ${slug}`);
    }

    writeRunningStatusJson(homeAlpha, { running: true, startedAt: new Date().toISOString() });

    const after = daemonStatusBySlug();
    assert.equal(after['bridge-beta'].effectiveRunning, false, 'beta must not inherit alpha status');
    assert.equal(after['bridge-alpha'].effectiveRunning, true, 'alpha home was written');

    const afterEmb = embeddedStatusBySlug();
    assert.equal(afterEmb['bridge-beta'].running, false);
    assert.equal(afterEmb['bridge-alpha'].running, true);
  });

  it('with CTI_HOME set, ignores inherited CTI_BOT_NAME from parent (e.g. kanban) for display', () => {
    ensureBridgeHome('bridge-alpha', base);
    process.env.CTI_HOME = path.join(base, 'bridge-alpha');
    process.env.CTI_BOT_NAME = 'kanban';
    invalidateBridgePathsCache();
    assert.equal(getCtiBotDisplayName(), 'bridge-alpha');
  });

  it('getBridgeStatusForApi is running when only slave.* is effective (CTI_SLAVE_BRIDGE status shape)', () => {
    ensureBridgeHome('bridge-slave-only', base);
    const home = getCtiHomeForBridgeSlug('bridge-slave-only');
    const fakePid = process.pid;
    writeRunningStatusJson(home, {
      slave: {
        running: true,
        pid: fakePid,
        startedAt: new Date().toISOString(),
      },
    });
    const disk = readBridgeDaemonDiskStatus(home);
    assert.equal(disk.effectiveRunning, false, 'top-level master not running');
    assert.equal(disk.slave?.effectiveRunning, true, 'slave slot should be effective');
    const emb = getBridgeStatusForApi(home);
    assert.equal(emb.running, true, 'API should treat slave-up as bridge running');
  });
});

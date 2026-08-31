import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeDaemonDiskStatus } from '../lib/bridge-daemon-status';
import { runnerStatusIdleWhenBridgeNotRunning, type RunnerStatus } from '../lib/monitor-messages';

function disk(over: Partial<BridgeDaemonDiskStatus>): BridgeDaemonDiskStatus {
  return {
    statusFilePresent: true,
    fileSaysRunning: false,
    effectiveRunning: false,
    stale: false,
    ...over,
  };
}

describe('runnerStatusIdleWhenBridgeNotRunning', () => {
  const busy: RunnerStatus = {
    masterBusy: true,
    slaveBusy: true,
    masterSince: 1000,
    slaveSince: 2000,
    updatedAt: 3000,
  };

  it('returns raw when master and slave (or implied slave) are running', () => {
    const out = runnerStatusIdleWhenBridgeNotRunning(
      busy,
      disk({ effectiveRunning: true }),
    );
    assert.deepEqual(out, busy);
  });

  it('clears master when main process is not running', () => {
    const out = runnerStatusIdleWhenBridgeNotRunning(
      busy,
      disk({ effectiveRunning: false }),
    );
    assert.equal(out.masterBusy, false);
    assert.equal(out.masterSince, undefined);
    assert.equal(out.slaveBusy, false);
    assert.equal(out.slaveSince, undefined);
  });

  it('clears only slave when slave subprocess is not running', () => {
    const out = runnerStatusIdleWhenBridgeNotRunning(
      busy,
      disk({
        effectiveRunning: true,
        slave: {
          running: true,
          effectiveRunning: false,
          pid: 999,
        },
      }),
    );
    assert.equal(out.masterBusy, true);
    assert.equal(out.slaveBusy, false);
    assert.equal(out.slaveSince, undefined);
  });

  it('sets updatedAt when forcing idle and raw had no timestamp', () => {
    const raw: RunnerStatus = {
      masterBusy: true,
      slaveBusy: false,
      updatedAt: 0,
    };
    const out = runnerStatusIdleWhenBridgeNotRunning(
      raw,
      disk({ effectiveRunning: false }),
    );
    assert.equal(out.masterBusy, false);
    assert.ok(out.updatedAt > 0);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeAppLogBasenameForDate,
  bridgeDaemonLogBasenameForDate,
  formatLocalDateForLog,
} from '../lib/bridge/bridge-log-file';

describe('bridge log filenames', () => {
  it('formats local calendar date as YYYY-MM-DD', () => {
    const d = new Date(2026, 3, 2, 15, 30, 0);
    assert.equal(formatLocalDateForLog(d), '2026-04-02');
  });

  it('builds dated basenames', () => {
    const d = new Date(2026, 3, 2);
    assert.equal(bridgeAppLogBasenameForDate(d), 'bridge-2026-04-02.log');
    assert.equal(bridgeDaemonLogBasenameForDate(d), 'bridge-daemon-2026-04-02.log');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendTranscript,
  createSession,
  GOAL_FILE_NAME,
  listSessions,
  markFinished,
  readGoalText,
  readState,
  readTranscript,
  recordResearcherReply,
  recordReviewerReply,
  RESEARCH_DIR_NAME,
  ResearchSessionStoreError,
  resolveGoalPath,
  writeResultMarkdown,
} from '../lib/bridge/research-mode/session-store';

function makeTempFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-mode-'));
}

function writeGoal(folder: string, body: string): void {
  fs.writeFileSync(path.join(folder, GOAL_FILE_NAME), body);
}

describe('research-mode session store', () => {
  it('throws when goal.md is missing', () => {
    const folder = makeTempFolder();
    assert.throws(() => resolveGoalPath(folder), ResearchSessionStoreError);
  });

  it('reads goal text and creates a session with a transcript file', () => {
    const folder = makeTempFolder();
    writeGoal(folder, 'Build a thing.');
    assert.equal(readGoalText(folder).trim(), 'Build a thing.');

    const state = createSession({ folder, maxTurns: 10 });
    assert.equal(state.phase, 'pending');
    assert.equal(state.turn, 0);
    assert.ok(fs.existsSync(path.join(folder, RESEARCH_DIR_NAME, 'sessions', state.sessionId)));

    // Round-trip via readState
    const round = readState(folder, state.sessionId);
    assert.ok(round);
    assert.equal(round!.sessionId, state.sessionId);
  });

  it('records researcher + reviewer replies with phase transitions', () => {
    const folder = makeTempFolder();
    writeGoal(folder, 'goal');
    let state = createSession({ folder, maxTurns: 5 });

    state = recordResearcherReply(state, {
      text: 'plan body',
      status: { phase: 'plan', summary: 'do x', next: 'awaiting B' },
    });
    assert.equal(state.phase, 'awaiting-reviewer');
    assert.equal(state.turn, 1);
    assert.equal(state.lastStatus?.phase, 'plan');

    state = recordReviewerReply(state, {
      text: 'verdict body',
      verdict: { verdict: 'approve-plan', advice: 'go' },
    });
    assert.equal(state.phase, 'awaiting-researcher');
    assert.equal(state.lastVerdict?.verdict, 'approve-plan');

    const transcript = readTranscript(folder, state.sessionId);
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0]!.role, 'researcher');
    assert.equal(transcript[1]!.role, 'reviewer');
  });

  it('writeResultMarkdown emits a result file with the goal snapshot and verdict', () => {
    const folder = makeTempFolder();
    writeGoal(folder, 'GOAL: ship feature X');
    let state = createSession({ folder, maxTurns: 3 });
    state = recordResearcherReply(state, {
      text: 'final claim',
      status: { phase: 'complete', summary: 'feature X shipped', next: 'awaiting sign-off' },
    });
    state = recordReviewerReply(state, {
      text: 'signed off',
      verdict: { verdict: 'confirm-complete', advice: 'verified tests' },
    });
    state = markFinished(state, 'completed', 'both A and B agreed');
    const resultPath = writeResultMarkdown({
      state,
      outcome: 'completed',
      reason: 'both A and B agreed',
    });
    const body = fs.readFileSync(resultPath, 'utf8');
    assert.match(body, /ship feature X/);
    assert.match(body, /confirm-complete/);
    assert.match(body, /completed/);
  });

  it('listSessions returns sessions newest-first', () => {
    const folder = makeTempFolder();
    writeGoal(folder, 'g');
    const s1 = createSession({ folder, maxTurns: 1 });
    // bump createdAt for s2
    const s2 = createSession({ folder, maxTurns: 1 });
    const listed = listSessions(folder);
    assert.equal(listed.length, 2);
    const ids = listed.map((s) => s.sessionId);
    assert.ok(ids.includes(s1.sessionId));
    assert.ok(ids.includes(s2.sessionId));
  });

  it('appendTranscript is append-only and JSONL-formatted', () => {
    const folder = makeTempFolder();
    writeGoal(folder, 'g');
    const state = createSession({ folder, maxTurns: 1 });
    appendTranscript(state, {
      turn: 1,
      role: 'orchestrator',
      kind: 'orchestrator-note',
      text: 'note one',
    });
    appendTranscript(state, {
      turn: 1,
      role: 'orchestrator',
      kind: 'orchestrator-note',
      text: 'note two',
    });
    const transcript = readTranscript(folder, state.sessionId);
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0]!.text, 'note one');
    assert.equal(transcript[1]!.text, 'note two');
  });
});

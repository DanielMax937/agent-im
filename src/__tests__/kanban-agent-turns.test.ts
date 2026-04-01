import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildKanbanMonitorTurnRecord, resolveKanbanTurnSource } from '../platform/kanban-agent-turn';
import type { TaskQueueMessage, TaskSession } from '../platform/types';
import { createTestJsonPlatformStore } from './platform-test-helpers';

describe('kanban_agent_turns', () => {
  it('inserts and lists by project and task id', () => {
    const store = createTestJsonPlatformStore();
    const row = store.insertKanbanAgentTurn({
      id: 'turn-1',
      projectId: 'p1',
      taskSessionId: 'ts1',
      taskId: 'DEMO-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceAgent: '',
      targetAgent: '开发',
      sourceAgentResponse: '',
      targetAgentPrompt: '=== SYSTEM PROMPT ===\nhello',
    });

    assert.equal(row.id, 'turn-1');

    const byProject = store.listKanbanAgentTurns({ projectId: 'p1' });
    assert.equal(byProject.total, 1);
    assert.equal(byProject.rows[0]?.targetAgentPrompt.includes('SYSTEM'), true);

    const miss = store.listKanbanAgentTurns({ projectId: 'p1', taskId: 'OTHER' });
    assert.equal(miss.total, 0);

    const hit = store.listKanbanAgentTurns({ projectId: 'p1', taskId: 'DEMO-1' });
    assert.equal(hit.total, 1);

    const one = store.getKanbanAgentTurn('turn-1');
    assert.ok(one);
    assert.equal(one?.targetAgent, '开发');

    const missing = store.getKanbanAgentTurn('nope');
    assert.equal(missing, null);
  });

  it('updates stream_error after insert', () => {
    const store = createTestJsonPlatformStore();
    store.insertKanbanAgentTurn({
      id: 'turn-2',
      projectId: 'p1',
      taskSessionId: 'ts1',
      taskId: 'DEMO-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceAgent: '',
      targetAgent: '开发',
      sourceAgentResponse: '',
      targetAgentPrompt: 'prompt',
    });
    store.updateKanbanAgentTurnStreamError('turn-2', 'boom');
    const row = store.getKanbanAgentTurn('turn-2');
    assert.equal(row?.streamError, 'boom');
    store.updateKanbanAgentTurnStreamError('turn-2', null);
    const cleared = store.getKanbanAgentTurn('turn-2');
    assert.equal(cleared?.streamError, undefined);
  });
});

describe('buildKanbanMonitorTurnRecord', () => {
  const qBase = {
    id: 'm1',
    queueKey: 'q',
    taskSessionId: 'ts',
    taskId: 'DEMO-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as const;

  const taskStub = { kanbanAgent: 'agent-dev' } as TaskSession;
  const rt = 'claude' as const;

  it('sets target to plain role name for human_followup', () => {
    const out = buildKanbanMonitorTurnRecord({
      queueMessage: { ...qBase, type: 'human_followup', content: 'note' } as TaskQueueMessage,
      taskSession: taskStub,
      instanceRole: 'developer',
      runtime: rt,
      historyBeforeUser: [],
    });
    assert.equal(out.sourceAgent, 'Human');
    assert.equal(out.targetAgent, '开发/claude');
  });

  it('sets target to 评审 for reviewer instance', () => {
    const out = buildKanbanMonitorTurnRecord({
      queueMessage: { ...qBase, type: 'directive', content: 'go' } as TaskQueueMessage,
      taskSession: taskStub,
      instanceRole: 'reviewer',
      runtime: rt,
      historyBeforeUser: [
        {
          id: 'e1',
          role: 'assistant',
          source: 'developer',
          content: 'PR ready',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    assert.equal(out.targetAgent, '评审/claude');
  });

  it('keeps system_check target as system check', () => {
    const out = buildKanbanMonitorTurnRecord({
      queueMessage: { ...qBase, type: 'system_check', content: 'check' } as TaskQueueMessage,
      taskSession: taskStub,
      instanceRole: 'developer',
      runtime: rt,
      historyBeforeUser: [
        {
          id: 'e1',
          role: 'assistant',
          source: 'developer',
          content: 'wip',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    assert.equal(out.sourceAgent, '开发/claude');
    assert.equal(out.targetAgent, 'system check');
  });
});

describe('resolveKanbanTurnSource', () => {
  it('returns empty source on first directive kickoff', () => {
    const out = resolveKanbanTurnSource({
      queueMessage: {
        id: 'm1',
        queueKey: 'q',
        taskSessionId: 'ts',
        taskId: 't',
        type: 'directive',
        content: 'Begin',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      historyBeforeUser: [],
      runtime: 'claude',
    });
    assert.deepEqual(out, { sourceAgent: '', sourceAgentResponse: '' });
  });

  it('uses last assistant after prior turns', () => {
    const out = resolveKanbanTurnSource({
      queueMessage: {
        id: 'm2',
        queueKey: 'q',
        taskSessionId: 'ts',
        taskId: 't',
        type: 'directive',
        content: 'Second',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      historyBeforeUser: [
        {
          id: 'e1',
          role: 'assistant',
          source: 'developer',
          content: 'Done with task.',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      runtime: 'claude',
    });
    assert.equal(out.sourceAgent, '开发/claude');
    assert.equal(out.sourceAgentResponse, 'Done with task.');
  });
});

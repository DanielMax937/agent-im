import type { Config, RunnerConfig } from '../config';
import { normalizeRunnersWithProcessEnvOverride } from '../config';
import type { LLMProvider } from '../lib/bridge/host';
import { getKanbanLogger } from './kanban-logger';
import type { Project } from './types';
import { consumeAgentStream, type StreamConsumeResult } from './stream-consumer';

/** Runner used for batch spec LLM: project’s codex-senior mapping, else first Codex runner. */
export function pickRunnerForCodexSenior(project: Project, config: Config): RunnerConfig | undefined {
  const runners = normalizeRunnersWithProcessEnvOverride(config);
  const id = project.kanbanRoleRunners?.['codex-senior']?.trim();
  if (id) {
    const r = runners.find((x) => x.id === id);
    if (r) return r;
  }
  return runners.find((r) => r.runtime === 'codex') ?? runners[0];
}

export interface BatchTaskPlanItem {
  title: string;
  /** Indices into the same `tasks` array; must refer only to earlier tasks (0 .. i-1). */
  dependsOnIndices: number[];
}

/**
 * Extract a balanced `{ ... }` slice starting at `start` (must point at `{`).
 * Handles `{` / `}` inside JSON strings. Avoids naive first-`{`/last-`}` bugs when
 * the model adds prose or multiple objects.
 */
export function extractBalancedJsonSlice(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJsonString(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function collectJsonCandidatesFromText(trimmed: string, into: unknown[]): void {
  const add = (json: string) => {
    const v = tryParseJsonString(json);
    if (v !== undefined) into.push(v);
  };

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const inner = m[1].trim();
    add(inner);
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] !== '{') continue;
      const bal = extractBalancedJsonSlice(inner, i);
      if (bal) add(bal);
    }
  }

  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '{') continue;
    const bal = extractBalancedJsonSlice(trimmed, i);
    if (bal) add(bal);
  }
}

function isRecordWithTasksArray(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Array.isArray((v as Record<string, unknown>).tasks);
}

/** Prefer the object whose shape matches batch-spec (`tasks` array), including after prose / fences. */
function pickBatchSpecJsonObject(candidates: unknown[]): unknown {
  const withTasks = candidates.filter(isRecordWithTasksArray);
  const nonEmpty = withTasks.filter((o) => (o.tasks as unknown[]).length > 0);
  if (nonEmpty.length) return nonEmpty[0];
  if (withTasks.length) return withTasks[0];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const objs = candidates.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null && !Array.isArray(c));
    if (objs.length) return objs[0];
  }
  if (candidates.length) return candidates[0];
  throw new Error('Model output did not contain a parseable JSON object');
}

export function extractJsonObjectFromAssistantText(text: string): unknown {
  const trimmed = text.trim();
  const candidates: unknown[] = [];
  collectJsonCandidatesFromText(trimmed, candidates);
  return pickBatchSpecJsonObject(candidates);
}

/** Validates POST body for `/api/workflows/tasks/batch-spec/preview`. */
export function parsePreviewBatchSpecBody(raw: unknown): { projectId: string; sprintId: string; rawText: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Request body must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const projectId = typeof o.projectId === 'string' ? o.projectId.trim() : '';
  const sprintId = typeof o.sprintId === 'string' ? o.sprintId.trim() : '';
  const rawText = typeof o.rawText === 'string' ? o.rawText.trim() : '';
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!sprintId) {
    throw new Error('sprintId is required');
  }
  if (!rawText) {
    throw new Error('rawText is required');
  }
  return { projectId, sprintId, rawText };
}

export function normalizeBatchTaskPlan(raw: unknown): BatchTaskPlanItem[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object with a "tasks" array');
  }
  const tasks = (raw as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('tasks must be a non-empty array');
  }
  const out: BatchTaskPlanItem[] = [];
  let i = 0;
  for (const row of tasks) {
    if (typeof row !== 'object' || row === null) {
      throw new Error(`tasks[${i}] must be an object`);
    }
    const o = row as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) {
      throw new Error(`tasks[${i}].title is required`);
    }
    let deps: number[] = [];
    if (o.dependsOnIndices !== undefined) {
      if (!Array.isArray(o.dependsOnIndices)) {
        throw new Error(`tasks[${i}].dependsOnIndices must be an array of numbers`);
      }
      deps = o.dependsOnIndices.map((x, j) => {
        if (typeof x !== 'number' || !Number.isInteger(x)) {
          throw new Error(`tasks[${i}].dependsOnIndices[${j}] must be an integer`);
        }
        return x;
      });
    }
    const seen = new Set<number>();
    for (const j of deps) {
      if (j < 0 || j >= i) {
        throw new Error(
          `tasks[${i}]: dependsOnIndices may only reference earlier tasks (indices 0 .. ${i - 1}), got ${j}`,
        );
      }
      if (seen.has(j)) {
        throw new Error(`tasks[${i}]: duplicate dependency index ${j}`);
      }
      seen.add(j);
    }
    out.push({ title, dependsOnIndices: deps });
    i += 1;
  }
  return out;
}

function normalizeBatchTaskPlanLoose(raw: unknown): BatchTaskPlanItem[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object with a "tasks" array');
  }
  const tasks = (raw as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('tasks must be a non-empty array');
  }
  return tasks.map((row, i) => {
    if (typeof row !== 'object' || row === null) {
      throw new Error(`tasks[${i}] must be an object`);
    }
    const o = row as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) {
      throw new Error(`tasks[${i}].title is required`);
    }
    const depsRaw = o.dependsOnIndices;
    if (depsRaw === undefined) {
      return { title, dependsOnIndices: [] };
    }
    if (!Array.isArray(depsRaw)) {
      throw new Error(`tasks[${i}].dependsOnIndices must be an array of numbers`);
    }
    const dependsOnIndices = depsRaw.map((x, j) => {
      if (typeof x !== 'number' || !Number.isInteger(x)) {
        throw new Error(`tasks[${i}].dependsOnIndices[${j}] must be an integer`);
      }
      return x;
    });
    return { title, dependsOnIndices };
  });
}

function batchSpecTimeoutMs(): number {
  const raw = process.env.CTI_KANBAN_BATCH_SPEC_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 180_000;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 180_000;
  return n;
}

const BATCH_SPEC_SYSTEM = [
  'You are a product manager planning Kanban work items for implementation.',
  'Focus only on concrete user-facing functionality, pages, flows, and feature slices.',
  'Do not break work down by low-level technical architecture, infrastructure, refactors, abstractions, schemas, edge-case handling, or acceptance criteria.',
  'Those implementation details, boundary cases, and verification rules belong to the developer/reviewer/tester lanes later.',
  'Each task should describe a visible product capability or page-level deliverable that a dev lane can implement.',
  'Hard rule: your entire message must be ONE JSON object. No other characters before or after.',
  'Do NOT use Markdown: no ## headings, no **bold**, no bullet lines, no numbered lists outside JSON, no ``` fences.',
  'Required shape: {"tasks":[{"title":"<string>","dependsOnIndices":[<ints>]}, ...]}',
  'Example (copy structure only): {"tasks":[{"title":"Add share page route","dependsOnIndices":[]},{"title":"Wire share API","dependsOnIndices":[0]}]}',
  'dependsOnIndices: 0-based indices of **earlier** tasks in the same `tasks` array that must finish before **this** task can start.',
  'Dependency rule (critical): if task B truly depends on work from task A, and A appears earlier in `tasks` at index i, then you MUST list i inside B\'s dependsOnIndices. Do not omit real dependencies; the system will create real Kanban links from this field.',
  'If tasks are parallel with no ordering constraint, use dependsOnIndices: [] for those tasks.',
  'Index 0 must use dependsOnIndices: []. For task at index i>0, only use indices from 0 to i-1.',
  'Order tasks topologically (dependencies point backward). Titles must be concise and actionable.',
].join('\n');

/** Second pass when the model returns prose/Markdown instead of JSON. */
const BATCH_SPEC_REPAIR_SYSTEM = [
  'You convert product planning text into exactly one JSON object for a Kanban batch import.',
  'Reply with ONLY valid JSON. First character must be {. Last character must be }.',
  'No Markdown, no code fences, no explanations, no labels before or after the JSON.',
  'Shape: {"tasks":[{"title":"string","dependsOnIndices":number[]}]}',
  'Keep tasks focused on pages, user flows, and visible features. Do not add technical implementation subtasks, edge-case subtasks, or acceptance/QA subtasks unless they are themselves user-facing features.',
  'dependsOnIndices: task index 0 uses []. Later tasks only reference earlier indices (0 .. i-1).',
  'Preserve every real dependency from the source: if item j must wait on item i (i<j), include i in tasks[j].dependsOnIndices.',
].join('\n');

/** Third pass: validate / repair dependency graph after a syntactically valid plan already exists. */
const BATCH_SPEC_DEPENDENCY_REVIEW_SYSTEM = [
  'You review and repair a Kanban task plan JSON object.',
  'Reply with ONLY one valid JSON object. First character must be {. Last character must be }.',
  'Shape: {"tasks":[{"title":"string","dependsOnIndices":number[]}]}',
  'Keep task titles unchanged unless absolutely required to clarify an existing task.',
  'Primary goal: repair dependency correctness.',
  'Rules:',
  '- dependsOnIndices may contain only unique integers pointing to earlier tasks.',
  '- Remove self-dependencies, forward references, invalid indices, and duplicates.',
  '- Add any missing earlier-task dependency that is clearly required by the task titles or requirement text.',
  '- Keep independent tasks with [].',
  '- Do not add or remove tasks unless the input is irreparably malformed; prefer minimal edits.',
  '- Preserve topological order: every dependency must point backward.',
].join('\n');

/** When not `0`, also mirror batch-spec dumps to stdout (Next dev terminal). Bridge log always receives structured lines when this runs. */
function batchSpecConsoleLogEnabled(): boolean {
  return process.env.CTI_KANBAN_BATCH_SPEC_LOG !== '0';
}

function logBatchSpecRunnerOutput(phase: string, rawChunks: string[], result: StreamConsumeResult): void {
  const rawJoined = rawChunks.join('');
  getKanbanLogger()
    .child({ scope: 'batch-spec' })
    .info(
      {
        phase,
        rawSseChunkCount: rawChunks.length,
        rawSseCharLength: rawJoined.length,
        rawRunnerSse: rawJoined,
        aggregatedAssistantText: result.responseText,
        hasError: result.hasError,
        streamErrorMessage: result.errorMessage || null,
        providerSessionId: result.providerSessionId,
      },
      'batch-spec preview: runner SSE + aggregated assistant text',
    );

  if (!batchSpecConsoleLogEnabled()) return;
  console.log(`\n[batch-spec] ========== ${phase} ==========`);
  console.log('[batch-spec] raw runner SSE stream (full):\n', rawJoined);
  console.log('[batch-spec] aggregated assistant text (full):\n', result.responseText);
  console.log('[batch-spec] hasError:', result.hasError, 'errorMessage:', result.errorMessage || '(none)');
  console.log('[batch-spec] providerSessionId:', result.providerSessionId);
}

async function runBatchSpecLlmPass(params: {
  provider: LLMProvider;
  workingDirectory: string;
  systemPrompt: string;
  userPrompt: string;
  sessionId: string;
  phase: string;
}): Promise<{ text: string; streamResult: StreamConsumeResult }> {
  const rawChunks: string[] = [];
  const stream = params.provider.streamChat({
    prompt: params.userPrompt,
    sessionId: params.sessionId,
    systemPrompt: params.systemPrompt,
    workingDirectory: params.workingDirectory,
    conversationHistory: [],
    disableLlmStreaming: true,
    /**
     * Codex maps this to a permissive approval policy so headless batch JSON extraction
     * does not stall waiting for tool/shell approval (see codex-provider `toApprovalPolicy`).
     */
    permissionMode: 'acceptEdits',
  });

  const streamResult = await consumeAgentStream(stream, {
    timeoutMs: batchSpecTimeoutMs(),
    rawStreamChunks: rawChunks,
  });
  logBatchSpecRunnerOutput(params.phase, rawChunks, streamResult);

  if (streamResult.timedOut) {
    throw new Error(streamResult.errorMessage || 'Batch spec LLM timed out');
  }
  if (streamResult.hasError) {
    throw new Error(streamResult.errorMessage || 'Batch spec LLM failed');
  }
  const text = streamResult.responseText.trim();
  if (!text) {
    throw new Error('Model returned empty text');
  }
  return { text, streamResult };
}

function normalizeFromAssistantTextOrThrow(text: string): BatchTaskPlanItem[] {
  const json = extractJsonObjectFromAssistantText(text);
  return normalizeBatchTaskPlan(json);
}

function normalizeLooseFromAssistantTextOrThrow(text: string): BatchTaskPlanItem[] {
  const json = extractJsonObjectFromAssistantText(text);
  return normalizeBatchTaskPlanLoose(json);
}

async function repairBatchTaskPlanDependencies(params: {
  provider: LLMProvider;
  workingDirectory: string;
  rawText: string;
  tasks: BatchTaskPlanItem[];
}): Promise<BatchTaskPlanItem[]> {
  const reviewUserPrompt = [
    'Review this task plan for dependency correctness and repair it if needed.',
    'Validate that every dependsOnIndices entry points only to earlier tasks and that obvious missing blockers are included.',
    'Return the repaired JSON object only.',
    '',
    'Original requirement/spec:',
    '---',
    params.rawText.trim().slice(0, 20_000),
    '---',
    '',
    'Candidate task plan JSON:',
    JSON.stringify({ tasks: params.tasks }),
  ].join('\n');

  const pass = await runBatchSpecLlmPass({
    provider: params.provider,
    workingDirectory: params.workingDirectory,
    systemPrompt: BATCH_SPEC_DEPENDENCY_REVIEW_SYSTEM,
    userPrompt: reviewUserPrompt,
    sessionId: `batch-spec-dependency-review-${Date.now()}`,
    phase: 'batch-spec preview pass 3 (dependency review)',
  });

  try {
    return normalizeFromAssistantTextOrThrow(pass.text);
  } catch (e) {
    const preview = pass.text.length > 500 ? `${pass.text.slice(0, 500)}…` : pass.text;
    const base = e instanceof Error ? e.message : String(e);
    throw new Error(`${base} — dependency review output preview: ${preview}`);
  }
}

/**
 * LLM call(s): pasted spec → validated task plan (高级开发 / codex runner).
 * If the first reply is prose/Markdown, a second pass asks the model to emit JSON only.
 */
export async function runBatchTaskSpecLlm(params: {
  provider: LLMProvider;
  workingDirectory: string;
  rawText: string;
}): Promise<BatchTaskPlanItem[]> {
  const raw = params.rawText.trim();
  if (!raw) {
    throw new Error('rawText is empty');
  }

  const userPrompt = [
    'Break the following pasted content into Kanban tasks. For each task you MUST set dependsOnIndices:',
    '- List the 0-based indices of earlier tasks this task cannot start until those are done.',
    '- If the spec implies a chain or blocking order, reflect it in dependsOnIndices (do not leave dependencies implicit).',
    '- Independent work uses dependsOnIndices: [].',
    '',
    '---',
    raw,
    '---',
    '',
    'Output constraint: your entire reply must be that single JSON object only. First character {. Last character }.',
  ].join('\n');

  const t0 = Date.now();
  const pass1 = await runBatchSpecLlmPass({
    provider: params.provider,
    workingDirectory: params.workingDirectory,
    systemPrompt: BATCH_SPEC_SYSTEM,
    userPrompt,
    sessionId: `batch-spec-${t0}`,
    phase: 'batch-spec preview pass 1',
  });

  try {
    const plan = normalizeFromAssistantTextOrThrow(pass1.text);
    return await repairBatchTaskPlanDependencies({
      provider: params.provider,
      workingDirectory: params.workingDirectory,
      rawText: raw,
      tasks: plan,
    });
  } catch {
    try {
      const loosePlan = normalizeLooseFromAssistantTextOrThrow(pass1.text);
      return await repairBatchTaskPlanDependencies({
        provider: params.provider,
        workingDirectory: params.workingDirectory,
        rawText: raw,
        tasks: loosePlan,
      });
    } catch {
      /* fall through to repair pass */
    }
  }

  const repairUserPrompt = [
    'The previous assistant reply was not valid JSON (it may have been Markdown or prose).',
    'Extract the work items and any "blocks / depends on / after" relationships from the text below.',
    'Encode dependencies ONLY via dependsOnIndices on each task (earlier task index i for blocker i).',
    'Reply with ONLY one JSON object. First character {. Last character }. No markdown, no commentary.',
    'Shape: {"tasks":[{"title":"string","dependsOnIndices":number[]}]}',
    '',
    '---',
    pass1.text.slice(0, 20_000),
    '---',
  ].join('\n');

  const pass2 = await runBatchSpecLlmPass({
    provider: params.provider,
    workingDirectory: params.workingDirectory,
    systemPrompt: BATCH_SPEC_REPAIR_SYSTEM,
    userPrompt: repairUserPrompt,
    sessionId: `batch-spec-repair-${Date.now()}`,
    phase: 'batch-spec preview pass 2 (JSON repair)',
  });

  try {
    const plan = normalizeFromAssistantTextOrThrow(pass2.text);
    return await repairBatchTaskPlanDependencies({
      provider: params.provider,
      workingDirectory: params.workingDirectory,
      rawText: raw,
      tasks: plan,
    });
  } catch (e) {
    try {
      const loosePlan = normalizeLooseFromAssistantTextOrThrow(pass2.text);
      return await repairBatchTaskPlanDependencies({
        provider: params.provider,
        workingDirectory: params.workingDirectory,
        rawText: raw,
        tasks: loosePlan,
      });
    } catch {
      /* fall through to final error */
    }
    const preview = pass2.text.length > 500 ? `${pass2.text.slice(0, 500)}…` : pass2.text;
    const base = e instanceof Error ? e.message : String(e);
    throw new Error(`${base} — model output preview: ${preview}`);
  }
}

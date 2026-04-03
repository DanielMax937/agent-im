/**
 * Second-phase master prompt: after static review passes, master must verify the
 * work and emit a machine-readable outcome. Verification scope is inferred from
 * the task context so simple info / API tasks do not always trigger browser work.
 */

export const MASTER_VERIFICATION_WALKTHROUGH_PREFIX = '## Master Verification Walkthrough';
export const MASTER_REVIEW_RESULT_JSON_PREFIX = 'REVIEW_RESULT_JSON:';
export const MASTER_VERIFICATION_RESULT_JSON_PREFIX = 'VERIFICATION_RESULT_JSON:';

export type VerificationOutcome = 'passed' | 'failed' | 'unknown';
export type MasterVerificationMode = 'api_only' | 'ui_and_api';
export type MasterReviewDecision = 'pass' | 'follow_up' | 'unknown';

const UI_SIGNAL_PATTERNS = [
  /\bui\b/i,
  /\bux\b/i,
  /\bpage\b/i,
  /\bfrontend\b/i,
  /\bbrowser\b/i,
  /\bdom\b/i,
  /\bhtml\b/i,
  /\bcss\b/i,
  /\breact\b/i,
  /\bnext\.?js\b/i,
  /\bscreenshot\b/i,
  /\bplaywright\b/i,
  /\bchrome devtools\b/i,
  /\bwebsite\b/i,
  /\bweb page\b/i,
  /\bbutton\b/i,
  /\bform\b/i,
  /\blayout\b/i,
  /\bcomponent\b/i,
  /\brender(?:ing)?\b/i,
  /https?:\/\/[^\s)]+/i,
];

function parsePassFlagFromTaggedJson(
  responseText: string,
  prefix: string,
): boolean | null {
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\{[^\\n]*\\})`, 'i');
  const match = responseText.match(pattern);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as { pass?: unknown };
    if (typeof parsed.pass === 'boolean') return parsed.pass;
    if (typeof parsed.pass === 'string') {
      const normalized = parsed.pass.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseMasterReviewDecision(responseText: string): MasterReviewDecision {
  const jsonPass = parsePassFlagFromTaggedJson(responseText, MASTER_REVIEW_RESULT_JSON_PREFIX);
  if (jsonPass === true) return 'pass';
  if (jsonPass === false) return 'follow_up';

  const resp = responseText.toLowerCase();
  const explicitPass =
    resp.includes('可以结案') ||
    resp.includes('可结案') ||
    resp.includes('任务完成') ||
    resp.includes('已做完') ||
    resp.includes('已满足') ||
    resp.includes('无需再派工') ||
    resp.includes('无需再打回') ||
    resp.includes('无需再派给从助手') ||
    resp.includes('无需再派给执行助手') ||
    resp.includes('no follow-up needed') ||
    resp.includes('no further action needed');
  const negatedNeedsImprovement =
    /needs?\s+improvement\s*[:：]\s*(?:no|false|否)/i.test(responseText) ||
    /(?:不要写|不在此写|不出现|勿出现|不要出现|正文中不要出现|回复中不要出现|回复中勿出现)[^.\n]{0,80}needs?\s+improvement/i.test(responseText) ||
    /do not include[^.\n]{0,80}needs?\s+improvement/i.test(responseText) ||
    /without[^.\n]{0,80}needs?\s+improvement/i.test(responseText);
  if (explicitPass || negatedNeedsImprovement) return 'pass';

  const needsFollowUp =
    resp.includes('follow-up') || resp.includes('follow up') ||
    resp.includes('please fix') || resp.includes('please improve') ||
    resp.includes('please run') || resp.includes('please test') ||
    resp.includes('please verify') || resp.includes('please check') ||
    resp.includes('please add') || resp.includes('please update') ||
    resp.includes('try again') || resp.includes('redo') ||
    resp.includes('not complete') || resp.includes('incomplete') ||
    (resp.includes('needs improvement') && !negatedNeedsImprovement) ||
    (resp.includes('need improvement') && !negatedNeedsImprovement) ||
    resp.includes('could be improved') || resp.includes('should be improved') ||
    resp.includes('missing') || resp.includes('incorrect') ||
    resp.includes('run tests') || resp.includes('run the tests') ||
    resp.includes('verify your') || resp.includes('test your') ||
    resp.includes('## follow-up instructions');
  return needsFollowUp ? 'follow_up' : 'pass';
}

export function parseVerificationOutcome(responseText: string): VerificationOutcome {
  const jsonPass = parsePassFlagFromTaggedJson(responseText, MASTER_VERIFICATION_RESULT_JSON_PREFIX);
  if (jsonPass === true) return 'passed';
  if (jsonPass === false) return 'failed';
  const m = responseText.match(/VERIFICATION_OUTCOME:\s*(PASSED|FAILED)\b/i);
  if (!m) return 'unknown';
  return m[1].toUpperCase() === 'PASSED' ? 'passed' : 'failed';
}

export interface MasterVerificationWalkthroughOptions {
  /** True when the slave already iterated on master feedback — run the same checks again, no shortcuts. */
  isReverify?: boolean;
  /** Explicit override for verification scope. */
  mode?: MasterVerificationMode;
  /**
   * Raw slave execution report body (or any full-context text). When provided,
   * `inferMasterVerificationMode` scans this first instead of only the truncated summary tail,
   * giving a more reliable UI vs API mode decision.
   */
  sourceText?: string;
  /**
   * Shell command to run for coverage gate (e.g. `npm run test:coverage`).
   * Only applied when `taskInvolvesCode` is `true` (or unset/unknown).
   */
  coverageCommand?: string;
  /**
   * Historical peak coverage percentage stored from previous passing verifications.
   * When provided, the coverage gate requires new coverage ≥ this value.
   * Takes precedence over `coverageMinPct` if both are set.
   */
  coverageBaseline?: number | null;
  /**
   * Hard-coded minimum required coverage percentage (0–100) from config.
   * Used as floor when `coverageBaseline` is null/unset.
   */
  coverageMinPct?: number;
  /**
   * Whether the slave's work involved code changes. Coverage gate is only added when this is
   * `true`. When `undefined` (unknown), coverage gate is skipped to avoid false positives.
   */
  taskInvolvesCode?: boolean;
}

export function inferMasterVerificationMode(
  sessionSummaryTail: string,
  sourceText?: string,
): MasterVerificationMode {
  // Prefer scanning the full source text (slave report body) — it is not truncated.
  const haystack = sourceText ?? sessionSummaryTail;
  for (const pattern of UI_SIGNAL_PATTERNS) {
    if (pattern.test(haystack)) return 'ui_and_api';
  }
  // Fallback: also scan the summary tail in case sourceText was API-only but summary reveals UI context.
  if (sourceText) {
    for (const pattern of UI_SIGNAL_PATTERNS) {
      if (pattern.test(sessionSummaryTail)) return 'ui_and_api';
    }
  }
  return 'api_only';
}

function buildReverifyBlock(options?: MasterVerificationWalkthroughOptions): string {
  return options?.isReverify
    ? `

### Re-verification (required)
The slave submitted a new report **after fixing issues**. You must run the required verification for this mode again with the same rigor. Do not assume the previous run still holds.

**Loop until clean:** If you find any bug or mismatch, output \`VERIFICATION_OUTCOME: FAILED\` and list issues; the slave will fix them and you will verify again. Only emit \`VERIFICATION_OUTCOME: PASSED\` when there are no remaining issues.
`
    : `

### If verification fails
Output \`VERIFICATION_OUTCOME: FAILED\` with concrete issues. The slave will fix them and send a new **Slave Execution Report**; you will then run this walkthrough again until a run ends with \`VERIFICATION_OUTCOME: PASSED\`.
`;
}

function buildApiOnlyChecks(): string {
  return `### Required verification (API_ONLY)

1. **Terminal / API / local command verification**
   - Use **curl**, shell commands, or other terminal checks to verify the important claims in the slave report.
   - Prefer lightweight checks that directly prove the answer: status codes, body snippets, local command output, computed values, or file contents as appropriate.
   - If the task has no HTTP API, state **N/A** and verify via shell/local commands instead.

2. **Browser validation**
   - Default to **N/A** for this mode.
   - Only use browser tools if the session context explicitly requires webpage/UI validation.

3. **Finish line**
   - Decide whether the work is really done based on the checks above. Do not ask the slave to repeat the same verification unless you found a concrete mismatch.
`;
}

function buildUiAndApiChecks(): string {
  return `### Required verification (UI_AND_API)

1. **Frontend — Playwright + local Google Chrome**
   - Use **Playwright with local Google Chrome** (\`--channel chrome\`) to open the relevant pages and interact as a user would.
   - Judge the UI by inspecting the **DOM**, page text, attributes, visibility, enabled/disabled state, navigation results, console messages, and network results.
   - Do **not** use screenshots or image analysis as a required verification step.
   - Do **not** use Chrome DevTools MCP for this verification flow.
   - If you cannot load a page or complete the interaction, say why and set outcome to FAILED.

2. **HTTP APIs / terminal checks**
   - Use **curl** or terminal commands to exercise important endpoints and supporting checks. Record status codes and short body snippets.
   - If the task has no HTTP API, state **N/A** and skip that part.

3. **Finish line**
   - Only after completing the applicable UI and API checks, decide if the work is really done.
`;
}

function buildCoverageGate(coverageCommand: string, minPct?: number, baseline?: number | null): string {
  // Effective minimum: take the higher of baseline and hard-coded minPct
  const effectiveMin = baseline != null && (minPct === undefined || baseline > minPct)
    ? baseline
    : minPct;
  const baselineNote = baseline != null
    ? `   - Previous peak coverage: **${baseline}%** (stored from last passing verification).`
    : `   - No previous coverage baseline recorded yet — this run establishes the baseline.`;
  const minLine = effectiveMin !== undefined
    ? `   - The total coverage **must be ≥ ${effectiveMin}%**. If it is lower, output \`VERIFICATION_OUTCOME: FAILED\` and include the actual coverage and the required minimum in \`## Issues found\`.`
    : `   - Record the total coverage percentage in your narrative. After this run, end your output with: \`COVERAGE_RESULT: <percentage>\` so the system can record it as the baseline.`;
  const reportLine = effectiveMin !== undefined
    ? `   - After reporting coverage, end your output with: \`COVERAGE_RESULT: <percentage>\` (numeric, e.g. \`COVERAGE_RESULT: 83.5\`).`
    : '';
  return `### Coverage gate (required — code changes detected)

1. **Run the test coverage command**
   \`\`\`
   ${coverageCommand}
   \`\`\`
   - Extract the overall/total coverage percentage from the command output or generated report file (e.g. \`coverage-summary.json\`, lcov).
${baselineNote}
${minLine}
${reportLine}
   - If the command fails to run, output \`VERIFICATION_OUTCOME: FAILED\` and include the error.

`;
}

export const COVERAGE_RESULT_PREFIX = 'COVERAGE_RESULT:';

/**
 * @param sessionSummaryTail Rolling session summary (truncated) for context
 */
export function buildMasterVerificationWalkthroughPrompt(
  sessionSummaryTail: string,
  options?: MasterVerificationWalkthroughOptions,
): string {
  const ctx = sessionSummaryTail.slice(-3500);
  const mode = options?.mode ?? inferMasterVerificationMode(ctx, options?.sourceText);
  const checks = mode === 'ui_and_api' ? buildUiAndApiChecks() : buildApiOnlyChecks();
  const modeLine = mode === 'ui_and_api' ? 'UI_AND_API' : 'API_ONLY';

  // Coverage gate: only when a command is configured AND the task explicitly involves code changes.
  // When taskInvolvesCode is undefined (unknown), skip to avoid false positives on non-code tasks.
  const shouldRunCoverage = !!(options?.coverageCommand && options?.taskInvolvesCode === true);
  const coverageSection = shouldRunCoverage
    ? buildCoverageGate(options!.coverageCommand!, options?.coverageMinPct, options?.coverageBaseline)
    : '';

  return `${MASTER_VERIFICATION_WALKTHROUGH_PREFIX}

You are the **master** runner. The initial review accepted the slave's work on paper. You must **prove** it works using the checks required for this verification mode before the task can be marked finished.
${buildReverifyBlock(options)}
### Verification mode
${modeLine}

### Session context (rolling summary tail)
${ctx}

${coverageSection}${checks}

### Output format (required)

- Brief narrative of what you ran and observed.
- Start your conclusion section with exactly:
  \`VERIFICATION_ACTION: ${modeLine}\`
- If anything is wrong, list issues under \`## Issues found\` with concrete repro steps.
- End with a single-line JSON verdict:
  \`${MASTER_VERIFICATION_RESULT_JSON_PREFIX} {"pass": true}\`
  or
  \`${MASTER_VERIFICATION_RESULT_JSON_PREFIX} {"pass": false}\`
- End with **exactly one** machine-readable line:
  \`VERIFICATION_OUTCOME: PASSED\`
  or
  \`VERIFICATION_OUTCOME: FAILED\`

Use **PASSED** only if the required checks for this mode show no blocking issues. Use **FAILED** for any bug, mismatch, missing proof, or incomplete verification.

The user sees this message on Telegram — keep it readable.`;
}

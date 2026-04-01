/**
 * Second-phase master prompt: after static review passes, master must verify the
 * work and emit a machine-readable outcome. Verification scope is inferred from
 * the task context so simple info / API tasks do not always trigger browser MCP.
 */

export const MASTER_VERIFICATION_WALKTHROUGH_PREFIX = '## Master Verification Walkthrough';

export type VerificationOutcome = 'passed' | 'failed' | 'unknown';
export type MasterVerificationMode = 'api_only' | 'ui_and_api';

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

export function parseVerificationOutcome(responseText: string): VerificationOutcome {
  const m = responseText.match(/VERIFICATION_OUTCOME:\s*(PASSED|FAILED)\b/i);
  if (!m) return 'unknown';
  return m[1].toUpperCase() === 'PASSED' ? 'passed' : 'failed';
}

export interface MasterVerificationWalkthroughOptions {
  /** True when the slave already iterated on master feedback — run the same checks again, no shortcuts. */
  isReverify?: boolean;
  /** Explicit override for verification scope. */
  mode?: MasterVerificationMode;
}

export function inferMasterVerificationMode(sessionSummaryTail: string): MasterVerificationMode {
  for (const pattern of UI_SIGNAL_PATTERNS) {
    if (pattern.test(sessionSummaryTail)) return 'ui_and_api';
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

2. **Browser / Chrome DevTools MCP**
   - Default to **N/A** for this mode.
   - Only use browser tools if the session context explicitly requires webpage/UI validation.

3. **Finish line**
   - Decide whether the work is really done based on the checks above. Do not ask the slave to repeat the same verification unless you found a concrete mismatch.
`;
}

function buildUiAndApiChecks(): string {
  return `### Required verification (UI_AND_API)

1. **Frontend — Chrome DevTools MCP**
   - Use **chrome-devtools** MCP (or equivalent browser control): open the relevant pages, interact as a user would, and check **console** and **network** for errors.
   - **Screenshots are mandatory** for UI you claim works: take a screenshot, then analyze the image in your reply and confirm visible text/layout matches expectations.
   - If you cannot load a page, say why and set outcome to FAILED.

2. **HTTP APIs / terminal checks**
   - Use **curl** or terminal commands to exercise important endpoints and supporting checks. Record status codes and short body snippets.
   - If the task has no HTTP API, state **N/A** and skip that part.

3. **Finish line**
   - Only after completing the applicable UI and API checks, decide if the work is really done.
`;
}

/**
 * @param sessionSummaryTail Rolling session summary (truncated) for context
 */
export function buildMasterVerificationWalkthroughPrompt(
  sessionSummaryTail: string,
  options?: MasterVerificationWalkthroughOptions,
): string {
  const ctx = sessionSummaryTail.slice(-3500);
  const mode = options?.mode ?? inferMasterVerificationMode(ctx);
  const checks = mode === 'ui_and_api' ? buildUiAndApiChecks() : buildApiOnlyChecks();
  const modeLine = mode === 'ui_and_api' ? 'UI_AND_API' : 'API_ONLY';

  return `${MASTER_VERIFICATION_WALKTHROUGH_PREFIX}

You are the **master** runner. The initial review accepted the slave's work on paper. You must **prove** it works using the checks required for this verification mode before the task can be marked finished.
${buildReverifyBlock(options)}
### Verification mode
${modeLine}

### Session context (rolling summary tail)
${ctx}

${checks}

### Output format (required)

- Brief narrative of what you ran and observed.
- Start your conclusion section with exactly:
  \`VERIFICATION_ACTION: ${modeLine}\`
- If anything is wrong, list issues under \`## Issues found\` with concrete repro steps.
- End with **exactly one** machine-readable line:
  \`VERIFICATION_OUTCOME: PASSED\`
  or
  \`VERIFICATION_OUTCOME: FAILED\`

Use **PASSED** only if the required checks for this mode show no blocking issues. Use **FAILED** for any bug, mismatch, missing proof, or incomplete verification.

The user sees this message on Telegram — keep it readable.`;
}

/**
 * Second-phase master prompt: after static code review passes, master must verify
 * via Chrome DevTools MCP (frontend + screenshots), curl (APIs), then emit a machine-readable outcome.
 */

export const MASTER_VERIFICATION_WALKTHROUGH_PREFIX = '## Master Verification Walkthrough';

export type VerificationOutcome = 'passed' | 'failed' | 'unknown';

export function parseVerificationOutcome(responseText: string): VerificationOutcome {
  const m = responseText.match(/VERIFICATION_OUTCOME:\s*(PASSED|FAILED)\b/i);
  if (!m) return 'unknown';
  return m[1].toUpperCase() === 'PASSED' ? 'passed' : 'failed';
}

export interface MasterVerificationWalkthroughOptions {
  /** True when the slave already iterated on master feedback — run the same checks again, no shortcuts. */
  isReverify?: boolean;
}

/**
 * @param sessionSummaryTail Rolling session summary (truncated) for context
 */
export function buildMasterVerificationWalkthroughPrompt(
  sessionSummaryTail: string,
  options?: MasterVerificationWalkthroughOptions,
): string {
  const ctx = sessionSummaryTail.slice(-3500);
  const reverifyBlock = options?.isReverify
    ? `

### Re-verification (required)
The slave submitted a new report **after fixing issues** (code review and/or a previous failed verification). You must run the **full** walkthrough again — Chrome DevTools MCP, curl, screenshots + image analysis — **the same rigor as before**. Do not assume the last run still holds.

**Loop until clean:** If you find any bug or mismatch, output \`VERIFICATION_OUTCOME: FAILED\` and list issues; the slave will fix and you will receive **another** slave report, then you will run this walkthrough **again**. Only \`VERIFICATION_OUTCOME: PASSED\` when there are **no** remaining issues.
`
    : `

### If verification fails
Output \`VERIFICATION_OUTCOME: FAILED\` with concrete issues. The slave will fix them and send a new **Slave Execution Report**; you will then run **this same walkthrough again** on the next pass until a run ends with \`VERIFICATION_OUTCOME: PASSED\`.
`;

  return `${MASTER_VERIFICATION_WALKTHROUGH_PREFIX}

You are the **master** runner. The initial review accepted the slave's work on paper. You must **prove** it works using the steps below before the task can be marked finished.
${reverifyBlock}
### Session context (rolling summary tail)
${ctx}

### Required verification (do all that apply)

1. **Frontend — Chrome DevTools MCP**
   - Use **chrome-devtools** MCP (or equivalent browser control): open the relevant pages, interact as a user would, and check **console** and **network** for errors.
   - **Screenshots are mandatory** for UI you claim works: take a screenshot, then **analyze the image** in your reply and confirm visible text/layout matches expectations (not a vague “looks OK”).
   - If you cannot load a page, say why and set outcome to FAILED.

2. **HTTP APIs — curl**
   - Use **curl** in the terminal to exercise important endpoints (success paths, auth, validation errors as appropriate). Record status codes and short body snippets.
   - If the task has no HTTP API, state **N/A** and skip.

3. **Finish line**
   - Only after completing the applicable steps, decide if the work is **really** done.

### Output format (required)

- Brief narrative of what you ran and observed.
- If anything is wrong, list issues under \`## Issues found\` with concrete repro steps.
- End with **exactly one** machine-readable line:
  \`VERIFICATION_OUTCOME: PASSED\`
  or
  \`VERIFICATION_OUTCOME: FAILED\`

Use **PASSED** only if frontend checks (including screenshot analysis) and API checks (if applicable) show **no** blocking issues. Use **FAILED** for any bug, regression, broken API, or UI mismatch.

The user sees this message on Telegram — keep it readable.`;
}

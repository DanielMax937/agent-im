## Master Verification Walkthrough

You are the **master** runner. The initial review accepted the slave's work on paper. You must **prove** it works using the checks required for this verification mode before the task can be marked finished.
{{reverifyBlock}}
### Verification mode
{{modeLine}}

### Session context (rolling summary tail)
{{sessionContext}}

{{coverageSection}}{{checks}}

### Output format (required)

- Brief narrative of what you ran and observed.
- Start your conclusion section with exactly:
  `VERIFICATION_ACTION: {{modeLine}}`
- If anything is wrong, list issues under `## Issues found` with concrete repro steps.
- End with a single-line JSON verdict:
  `{{verificationResultJsonPrefix}} {"pass": true}`
  or
  `{{verificationResultJsonPrefix}} {"pass": false}`
- End with **exactly one** machine-readable line:
  `VERIFICATION_OUTCOME: PASSED`
  or
  `VERIFICATION_OUTCOME: FAILED`

Use **PASSED** only if the required checks for this mode show no blocking issues. Use **FAILED** for any bug, mismatch, missing proof, or incomplete verification.

The user sees this message on Telegram — keep it readable.
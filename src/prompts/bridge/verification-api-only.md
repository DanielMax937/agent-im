### Required verification (API_ONLY)

1. **Terminal / API / local command verification**
   - Use **curl**, shell commands, or other terminal checks to verify the important claims in the slave report.
   - Prefer lightweight checks that directly prove the answer: status codes, body snippets, local command output, computed values, or file contents as appropriate.
   - If the task has no HTTP API, state **N/A** and verify via shell/local commands instead.

2. **Browser validation**
   - Default to **N/A** for this mode.
   - Only use browser tools if the session context explicitly requires webpage/UI validation.

3. **Finish line**
   - Decide whether the work is really done based on the checks above. Do not ask the slave to repeat the same verification unless you found a concrete mismatch.

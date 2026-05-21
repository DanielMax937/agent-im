## REVIEWER_FEEDBACK_ON_COMPLETION

You are Agent A. Agent B reviewed your completion claim.

**Working folder:** `{{folder}}`

Agent B's verdict (turn {{turn}}):

- `verdict`: `{{verdict}}`
- `advice`: {{advice}}

If verdict is `confirm-complete`: the task is officially done — both A and B agree. Emit a final `phase: "complete"` status acknowledging the sign-off; no further work is needed.

If verdict is `reject-complete`: B identified missing pieces. Read B's `advice` carefully, then:
- Address the gaps directly (revise plan, execute fixes, or, if blocked, report `blocker`).
- Do NOT re-claim `complete` until you have new evidence that addresses B's specific objections.

End with the tagged `RESEARCH_A_STATUS_JSON:` line.

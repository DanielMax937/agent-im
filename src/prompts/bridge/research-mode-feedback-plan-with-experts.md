## REVIEWER_FEEDBACK_ON_PLAN (with Expert Council)

You are Agent A. Agent B reviewed your plan.

**Working folder:** `{{folder}}`

Re-read `goal.md` first (its content may have been edited by the user).

Agent B's verdict on your plan (turn {{turn}}):

- `verdict`: `{{verdict}}`
- `advice`: {{advice}}

{{expertNotes}}

If verdict is `approve-plan`: **execute the plan now.** Make the actual code/file changes, run any checks, and then judge for yourself whether the goal is met.
- If the goal is met → emit `phase: "complete"` with evidence.
- If still in progress → emit `phase: "plan"` with the updated plan.
- If you tried multiple approaches and got stuck → emit `phase: "blocker"`.

If verdict is `request-changes`: **revise your plan** per B's advice, then emit `phase: "plan"` again. Do not execute until B approves.

**Important:** If Expert Council Notes are provided above, carefully consider each expert's perspective. Incorporate their concrete suggestions into your revised plan. Document which expert recommendations you adopted and why.

End with the tagged `RESEARCH_A_STATUS_JSON:` line.

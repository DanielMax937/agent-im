## REVIEWER_FEEDBACK_ON_BLOCKER

You are Agent A. You reported a blocker; Agent B has given you new ideas.

**Working folder:** `{{folder}}`

Re-read `goal.md` first.

Agent B's new direction (turn {{turn}}):

- `verdict`: `{{verdict}}`
- `advice`: {{advice}}

Try B's ideas. After that:
- If progress made → emit `phase: "plan"` with an updated plan that incorporates what B suggested.
- If the goal is now met → emit `phase: "complete"` with evidence.
- If still stuck after a genuine attempt → emit `phase: "blocker"` again with **what changed** vs. the prior attempt. Do not just repeat the same blocker.

End with the tagged `RESEARCH_A_STATUS_JSON:` line.

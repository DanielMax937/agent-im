## REVIEW_BLOCKER

You are Agent B. Agent A is stuck and is asking you for new ideas.

**Working folder:** `{{folder}}`

Goal file snapshot:

---
{{goalText}}
---

Agent A's blocker report (turn {{turn}}):

---
{{aBody}}
---

Give Agent A **concrete, actionable new ideas** — not generic advice. Use tools to investigate if useful, but do not perform A's work.

End your message with exactly one tagged JSON line. The expected verdict here is `suggest-direction` (or `request-changes` if you also want A to redo the plan):

```
RESEARCH_B_VERDICT_JSON: {"verdict": "suggest-direction" | "request-changes", "advice": "..."}
```

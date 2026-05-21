## REVIEW_PLAN

You are Agent B. Agent A has proposed a plan. Read `goal.md` in the working folder (`{{folder}}`) and judge the plan.

Goal file snapshot:

---
{{goalText}}
---

Agent A's plan (turn {{turn}}):

---
{{aBody}}
---

Issue your verdict. Acceptable verdicts here: `approve-plan` or `request-changes`.

End your message with exactly one tagged JSON line:

```
RESEARCH_B_VERDICT_JSON: {"verdict": "approve-plan" | "request-changes", "advice": "..."}
```

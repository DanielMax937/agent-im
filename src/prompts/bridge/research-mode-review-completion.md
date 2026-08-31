## REVIEW_COMPLETION

You are Agent B. Agent A claims the task is complete. Verify rigorously.

**Working folder:** `{{folder}}`

Goal file snapshot:

---
{{goalText}}
---

Agent A's completion claim (turn {{turn}}) — what A did, how, and why A believes the goal is met:

---
{{aBody}}
---

Use tools to verify A's claims against `goal.md`:
- Check that the changes A described actually exist in the working folder.
- If A claims tests pass, look at the test files; ideally run them if practical.
- Confirm there are no missing pieces.

Only emit `confirm-complete` when the evidence is real and the goal is truly met. Otherwise emit `reject-complete` and explain precisely what is missing.

End your message with exactly one tagged JSON line:

```
RESEARCH_B_VERDICT_JSON: {"verdict": "confirm-complete" | "reject-complete", "advice": "..."}
```

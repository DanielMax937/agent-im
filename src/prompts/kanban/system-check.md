[Kanban system check — respond in your next assistant message]

Current workflow state: {{workflowState}} ({{workflowStateHint}}).
Your role for this lane: {{role}}.

1) {{roleActionInstruction}}
2) If you are done with this lane, do not send only a prose summary. You must either emit the correct final `KANBAN_ACTION:...` line or explicitly explain why you cannot advance yet.
{{laneSpecificRule}}3) If you still need to implement, fix, or explain more, continue working — do NOT add a KANBAN_ACTION line until you are ready.
4) If you are blocked, say what you need.

Task: {{taskIssueId}} — {{taskTitle}}
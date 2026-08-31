# Board Brainstorm Revision Design

## Goal

Improve the board-side “需求讨论” flow so users can turn a conversation into a structured design draft, revise that draft through explicit change requests, and generate Kanban todo tasks from the confirmed draft instead of from the full chat transcript.

## Current Context

The board UI already has a full-screen brainstorm modal backed by `POST /api/workflows/board-brainstorm/chat`. It streams replies from the `codex-senior` runner in read-only plan mode. The current “确认方案并生成待办任务” action formats the entire chat transcript and sends it into the existing batch-spec preview flow.

This works for simple conversations, but it has two problems:

- Early exploration and discarded ideas can pollute task generation.
- Users cannot clearly revise, compare, or confirm a specific version of the design before task splitting.

## Recommended Approach

Add an in-memory “方案稿” layer inside the brainstorm modal.

The chat remains the place for discussion and clarification. A draft panel becomes the place for structured, confirmable design output. Users can generate a draft from the chat, revise the selected draft with explicit instructions, keep version history, and generate todo tasks from the selected draft.

This keeps the first version lightweight because no persistence or database migration is required.

## State Model

Add the following client-side state to the board page:

```ts
type BrainstormDraft = {
  id: string;
  version: number;
  title: string;
  content: string;
  sourceMessageCount: number;
  createdAt: string;
};
```

Required state:

- `brainstormDrafts`: all generated draft versions for the current modal session.
- `selectedDraftId`: currently displayed and confirmed draft.
- `draftMode`: `idle | generating | revising`.
- `revisionInstruction`: user-entered change request for the selected draft.

Drafts are intentionally session-local for the first release. Starting a new conversation clears drafts, selected draft, and revision instruction.

## API Shape

Reuse `POST /api/workflows/board-brainstorm/chat` and add an `intent` field:

```ts
type BoardBrainstormIntent = 'chat' | 'draft' | 'revise';
```

For normal chat:

```json
{
  "intent": "chat",
  "projectId": "...",
  "sessionId": "...",
  "sdkSessionId": "...",
  "message": "...",
  "conversationHistory": []
}
```

For draft generation:

```json
{
  "intent": "draft",
  "projectId": "...",
  "sessionId": "...",
  "sdkSessionId": "...",
  "message": "Generate a structured design draft from the conversation.",
  "conversationHistory": []
}
```

For revision:

```json
{
  "intent": "revise",
  "projectId": "...",
  "sessionId": "...",
  "sdkSessionId": "...",
  "message": "...revision instruction...",
  "conversationHistory": [],
  "currentDraft": "..."
}
```

The backend should keep the same runner selection, read-only sandbox, disabled network, and plan permission mode. Only the prompt envelope changes by intent.

## Prompt Contract

For `chat`, keep the existing brainstorming behavior: clarify, compare approaches, and design in sections.

For `draft`, the assistant should output only a complete Markdown draft with this structure:

```md
# 方案稿

## 目标
## 范围
## 非目标
## 推荐方案
## UI 设计
## 数据与 API
## 任务拆分建议
## 验收标准
## 风险与边界
```

For `revise`, the assistant should receive the current draft and the revision instruction, then output only the new complete Markdown draft. It should not include conversational commentary, diff explanations, or partial patches.

## UI Design

Change the brainstorm modal body to a two-column layout:

- Left column: existing chat transcript, message input, and send button.
- Right column: design draft panel.

On small screens, stack the chat above the draft panel.

The draft panel has three states:

- Empty: “先讨论需求，再生成方案稿”.
- Loading: show whether it is generating or revising.
- Ready: show version selector, metadata, Markdown body, revision input, and actions.

Primary actions:

- `生成方案稿`: enabled when there is at least one chat message and no active stream/draft request.
- `按意见改稿`: enabled when a draft is selected and the revision instruction is non-empty.
- `确认当前稿并生成待办`: enabled when project, sprint, and selected draft are available.
- `复制方案稿`: convenience action for manual review.

When a revision succeeds, append a new draft version instead of overwriting the old one, select it automatically, and append a lightweight chat-side status message such as “已生成方案稿 v3”.

## Batch Task Flow

When a selected draft exists, `确认当前稿并生成待办` should use the selected draft content as the source for batch-spec preview.

The old transcript-based path remains as a fallback when no draft exists. This preserves current behavior and reduces rollout risk.

The batch preview and creation APIs do not need to change.

## Error Handling

- If draft generation fails, keep the chat and existing drafts unchanged.
- If revision fails, keep the selected draft unchanged and preserve the revision instruction for retry.
- If batch preview fails, keep the brainstorm modal open.
- If no project or sprint is selected, reuse the existing global board error message pattern.
- If the stream returns an empty draft, show a specific error and do not create a new version.

## Testing

Unit-level coverage:

- Parse `intent`, `currentDraft`, and existing chat payloads.
- Reject invalid revision requests without `currentDraft`.
- Preserve backward compatibility when `intent` is omitted by treating it as `chat`.

UI/manual coverage:

- Generate a draft from chat.
- Revise a draft and confirm old versions remain selectable.
- Generate batch preview from the selected draft.
- Verify fallback transcript-based generation still works without a draft.
- Verify new conversation clears drafts and revision text.

## Rollout Notes

Implement this as a focused enhancement to the existing board brainstorm flow. Avoid adding persistence, server-side draft storage, or markdown rendering libraries in the first version. Plain pre-wrapped Markdown text is sufficient for the initial UI.

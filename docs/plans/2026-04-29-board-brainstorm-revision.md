# Board Brainstorm Revision Implementation Plan

## Goal

Add a draft-and-revision layer to the board-side “需求讨论” modal so users can generate a structured方案稿, revise it by version, and create Kanban todo tasks from the confirmed draft.

## Architecture

Keep the existing board brainstorm chat and batch-spec creation flows. Add a thin intent-based layer to the brainstorm API and local UI state for draft versions. The backend remains plan-only, read-only, and non-persistent for this first version.

## Tech Stack

- Next.js app router UI in `src/app/board/page.tsx`
- Platform API routing in `src/platform/app.ts`
- Brainstorm input parsing and prompt helpers in `src/platform/board-brainstorm.ts`
- Streaming execution in `src/platform/workflow-service.ts`
- Node test runner tests under `src/__tests__`

## Steps

1. Extend brainstorm request parsing
   - Update `src/platform/board-brainstorm.ts`.
   - Add `BoardBrainstormIntent = 'chat' | 'draft' | 'revise'`.
   - Treat missing `intent` as `chat` for backward compatibility.
   - Add optional `currentDraft`.
   - Reject `revise` requests when `currentDraft` is empty.

2. Add intent-aware prompt construction
   - Update `src/platform/workflow-service.ts`.
   - Keep the same runner, sandbox, permission, network, and working directory settings.
   - For `chat`, preserve the current prompt behavior.
   - For `draft`, wrap the user message with instructions to output only the structured Markdown draft.
   - For `revise`, include the current draft and revision instruction, then require a full replacement draft only.

3. Keep API route compatibility
   - Check `src/platform/app.ts`.
   - Ensure the existing `/api/workflows/board-brainstorm/chat` route accepts the new fields through the parser.
   - Avoid creating a new endpoint unless routing constraints require it.

4. Add frontend draft state
   - Update `src/app/board/page.tsx`.
   - Add `BrainstormDraft` type and state for `brainstormDrafts`, `selectedDraftId`, `draftMode`, and `revisionInstruction`.
   - Clear draft-related state when starting a new brainstorm conversation.
   - Derive `selectedDraft` from `brainstormDrafts` and `selectedDraftId`.

5. Implement draft and revise client actions
   - Add `generateBrainstormDraft()`.
   - Add `reviseBrainstormDraft()`.
   - Reuse the SSE parsing pattern from `sendBrainstormMessage()`.
   - Validate that returned draft content is non-empty before appending a version.
   - On successful revision, append a new version and select it.

6. Update batch-source selection
   - Update `confirmBrainstormPlanAndOpenBatch()` in `src/app/board/page.tsx`.
   - Prefer the selected draft content when available.
   - Keep the existing transcript formatting fallback when no draft exists.
   - Keep the existing batch preview and create flow unchanged.

7. Redesign the brainstorm modal body
   - Update the JSX in `src/app/board/page.tsx`.
   - Split the modal into chat and draft panel areas.
   - Add version selector, metadata, draft body, revision textarea, and actions.
   - Preserve existing close, new conversation, send, and keyboard behavior.
   - Use inline styles or existing utility classes to match current file style.

8. Add parser tests
   - Update `src/__tests__/board-brainstorm.test.ts`.
   - Cover default `chat` intent, explicit `draft`, valid `revise`, and invalid `revise` without `currentDraft`.
   - Ensure existing minimal payload test still passes.

9. Run focused verification
   - Run `npm test -- src/__tests__/board-brainstorm.test.ts` if supported by the project test runner.
   - Otherwise run the project’s existing `npm test` command or `npm run typecheck`.
   - Manually verify the modal flow in `/board`: chat, generate draft, revise draft, select old version, generate batch preview.

## Assumptions

- Draft persistence is out of scope for the first version.
- Plain pre-wrapped Markdown display is acceptable; no Markdown renderer is required.
- The existing batch-spec API can produce better tasks from the structured draft than from the full transcript.

## Open Questions

- Should `生成方案稿` also be exposed as a chat-side quick action after the assistant says the design is approved?
- Should draft versions include user-editable titles, or is `方案稿 vN` enough for the first version?

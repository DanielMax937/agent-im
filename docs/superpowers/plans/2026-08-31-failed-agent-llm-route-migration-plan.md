# Failed Agent and LLM Route Migration Implementation Plan

Date: 2026-08-31  
Design: `../specs/2026-08-31-failed-agent-llm-route-migration-design.md`  
Design commit: `2752d37`

## Goal

Implement scheme 1 across the audited M4 projects: migrate only failed local
LLM API paths to agent-im and only failed Agent paths/defaults to Codex, while
preserving all working provider paths and current explicit user selections.

## Execution Guardrails

- Work one repository at a time and record `git status --short` before editing.
- Treat every pre-existing modification/untracked file as user-owned.
- Use focused tests before and after each change; do not wait until the end to
  discover cross-project failures.
- Use loopback and temporary directories for real smokes.
- Do not publish, trade, deploy, message, crawl, compile a whole vault, write a
  production database, or mutate MacVoiceCode's current runner selection.
- Never print or copy credentials. agent-im LaunchAgent verification is
  sanitized to runner IDs, runtimes, models, and service status only.

## Plan

1. **Capture the multi-repository safety baseline.**

   Record current branch/commit and `git status --short` for every project in
   the approved matrix. Store the baseline under the current Codex task's
   `work/` directory, not in a project repository. Mark the existing agent-im
   changes in `src/codex-provider.ts`, `src/platform/app.ts`, their tests,
   `artifacts/`, and `docs/e2e/` as pre-existing and out of scope. Abort an
   individual repository change if a target file has overlapping user edits
   that cannot be preserved.

2. **Re-run the shared runtime preflight.**

   Verify `http://127.0.0.1:3300/health`, non-streaming `AGENT_IM_TEXT_OK`, SSE
   `AGENT_IM_STREAM_OK` plus `[DONE]`, PNG `AGENT_IM_PNG_OK`, JPEG
   `AGENT_IM_JPEG_OK`, and a read-only Codex `CODEX_OK` invocation. Confirm the
   agent-im Web/API LaunchAgent is loaded. Save only redacted outcomes and
   timings; do not save prompt/image payloads or environment dumps.

3. **Repair football's two local text clients.**

   Primary files:

   - `/Users/caoxiaopeng/Desktop/football/apps/sports-analytics-web/app/lib/openai-llm.ts`
   - `/Users/caoxiaopeng/Desktop/football/apps/sports-analytics-web/app/lib/harmony-news-translation.ts`
   - Existing tests `tests/openai-llm.test.ts` and
     `tests/harmony-news-translation.test.ts`

   Add deterministic `AGENT_IM_*` defaults, force the repaired automatic route
   to Chat Completions, retain current validation/logging, and keep explicitly
   selected Kimi behavior unchanged. Extend tests for environment precedence,
   empty responses, and no dead-provider fallback. Run focused tests, project
   typecheck/build if available, then one real marker call through each client.

4. **Split crawlers chat repair from unsupported transcription.**

   Primary files:

   - `/Users/caoxiaopeng/Desktop/git/crawlers/crawlers/sites/podcast/transcribe.py`
   - `/Users/caoxiaopeng/Desktop/git/crawlers/crawlers/sites/wechat/wechat.py`
   - `/Users/caoxiaopeng/Desktop/git/crawlers/crawlers/sites/rednote/rednote.py`
   - New focused tests under `crawlers/tests/`

   Give chat summarization/title/extraction helpers an agent-im client while
   leaving the podcast audio client and `audio.transcriptions.create` path
   separate. Test that audio never uses the chat endpoint, chat helpers resolve
   agent-im, and fabricated inputs return valid summaries. Do not run a crawler
   main function or write cache/database records.

5. **Normalize githubsync's non-stream and stream examples.**

   Primary files:

   - `/Users/caoxiaopeng/Desktop/githubsync/oneapi.py`
   - `/Users/caoxiaopeng/Desktop/githubsync/vol_test.py`
   - New `test_agent_im_examples.py`

   Replace the obsolete Gemini/Ark defaults and mismatched key variable with
   `AGENT_IM_*`. Keep `vol_test.py`'s SSE demonstration, validate terminal
   completion and non-empty output, and turn script-level exception printing
   into a failing exit status. Run syntax/tests and real marker calls for both
   non-streaming and streaming paths.

6. **Repair only the Chrome MCP miracleplus database chat skill.**

   Primary files:

   - `/Users/caoxiaopeng/Desktop/git/chrome-dev-mcp-server/skills/miracleplus-database/scripts/fetch_and_summarize.py`
   - Its config example/documentation and new focused tests beside the skill

   Resolve the skill's chat configuration from `AGENT_IM_*`, make the
   compatibility key non-secret, and preserve its summary/topic schemas.
   Explicitly leave `skills/news-market/scripts/analyze_news_market.py`
   embeddings unchanged. Test fabricated summary/topic records and assert the
   embedding code never points at agent-im.

7. **Repair all three futures text clients without running their writers.**

   Primary files:

   - `/Users/caoxiaopeng/m2-futures-migration/Desktop/futures/util/llm_client.py`
   - `/Users/caoxiaopeng/m2-futures-migration/Desktop/futures/auto/util/llm_client.py`
   - `/Users/caoxiaopeng/m2-futures-migration/Desktop/futures/scripts/summarize_news_llm.py`
   - Focused tests under the repository's existing test layout

   Replace the banned automatic proxy/default with deterministic agent-im
   configuration and add consistent non-empty/error handling. Preserve working
   Codex automations. Test each distinct client with fabricated news and invoke
   only its helper; never run the summarizer `main` that rewrites `news.json`.

8. **Migrate study-app's generate and grade entry points.**

   Primary files:

   - `/Users/caoxiaopeng/m2-futures-migration/Desktop/dailyreport/study-app/src/lib/server-env.ts`
   - `src/lib/openai-client.ts`
   - `src/app/api/quiz/generate/route.ts`
   - `src/app/api/quiz/grade/route.ts`
   - Focused Vitest files for config and both routes

   Replace invalid `DEEPSEEK_*` automatic resolution with `AGENT_IM_*`, preserve
   explicit domain limits, remove reliance on native `response_format`, and
   keep existing Zod/application validation plus bounded repair behavior.
   Create entry-point integration tests that reach the live agent-im client
   while stubbing only Supabase/rate-limit writes. Run test, typecheck, and
   build without posting to the production business routes.

9. **Convert gao's concrete Responses vision request.**

   Primary files:

   - `/Users/caoxiaopeng/m2-futures-migration/Documents/Codex/2026-06-29/gao/scripts/agent_review_runner.py`
   - New focused adapter tests

   Convert only system/user/assistant text, `input_text`, and PNG/JPEG data-URL
   `input_image` to Chat Completions. Reject remote images, other MIME types,
   previous-response state, tools, reasoning, files, audio, and unknown items.
   Make `auto` choose the repaired agent-im API path while preserving explicit
   Gemini and Codex CLI provider choices. Test conversion/rejection cases and
   run `call_openai` directly with an existing chart and a marker prompt; do not
   execute the batch runner or create review artifacts.

10. **Simplify dailyreport/wiki's class A and B-to-A paths.**

    Primary files:

    - `/Users/caoxiaopeng/m2-futures-migration/Desktop/dailyreport/wiki/99_Scripts/compile_vault.py`
    - `99_Scripts/codex_synthesize.sh`
    - New focused Python/shell tests under `99_Scripts/tests/`

    Make the compile helper use only agent-im for its repaired chat/vision
    route, with PNG/JPEG-only data URLs and remote-image rejection. In
    `codex_synthesize.sh`, retain Codex as primary but replace the multi-file
    dead-provider search with one explicit agent-im fallback. Implement the
    approved executable/model/timeout precedence and controlled bad
    `CODEX_BIN` behavior. Test compile helpers in isolation, then use temporary
    prompt/output files to prove both Codex-primary and intentional B-to-A
    fallback. Never compile the vault.

11. **Repair bitstripe's shared LLM module and Composer service.**

    Primary files:

    - `/Users/caoxiaopeng/DevEcoStudioProjects/bitstripe/huawei/llm.py`
    - `composer/llm-composer-server.mjs`
    - `composer/start-llm-composer.sh`
    - Call-site regression coverage for `codecrew/views.py` and
      `kousou/views.py`
    - New Python and Node focused tests

    Resolve agent-im defaults in `huawei/llm.py`, preserve existing non-stream,
    SSE, JSON, and verified PNG/JPEG inputs, and reject remote/unverified image
    inputs. Convert Composer `/responses` to `/chat/completions`, parse one JSON
    object, validate it with the existing schema, and make at most one bounded
    repair request. Fix the start script deterministically so it launches the
    real `composer/llm-composer-server.mjs`. Run Python tests, call-site tests,
    Node tests, then start the Composer on an unused loopback port and check
    `/health` plus a harmless `/v1/compose` fixture.

12. **Verify kousou-harmonyos indirect recovery without editing device code.**

    Primary target:

    - `/Users/caoxiaopeng/DevEcoStudioProjects/kousou-harmonyos` existing
      bitstripe receipt endpoint integration

    Assert the repository has no device/provider diff. Exercise the existing
    local receipt request with a harmless fixture against the repaired
    bitstripe endpoint. Record success or a bounded residual, but do not deploy
    to a device or introduce an agent-im URL into ArkTS.

13. **Convert newbrowser's local Composer, leaving ArkTS untouched.**

    Primary files:

    - `/Users/caoxiaopeng/DevEcoStudioProjects/newbrowser/scripts/llm-composer-server.mjs`
    - `scripts/start-llm-composer.sh`
    - New focused Node tests

    Replace Responses/native schema usage with agent-im Chat Completions,
    JSON-only prompting, existing schema validation, and one bounded repair.
    Add deterministic agent-im startup defaults and health configuration.
    Test successful JSON, fenced JSON, repair, terminal invalid output, timeout,
    4xx, transient retry, and unsupported request shapes. Start on an unused
    loopback port and POST a harmless compose fixture. Confirm
    `entry/src/main/ets/core/llm/LlmComposerClient.ets` has no diff.

14. **Move truth-debate-arena from Anthropic to an OpenAI-compatible AI SDK provider.**

    Primary files:

    - `/Users/caoxiaopeng/service/truth-debate-arena/lib/server/claude-config.ts`
      (replace/rename to provider-neutral config as required)
    - `lib/debate/ai-runtime.ts`
    - Importing route/config status files
    - `package.json` and lockfile
    - Existing/new Vitest coverage

    Add the AI SDK OpenAI-compatible provider package, resolve `AGENT_IM_*`, and
    preserve the existing ToolLoopAgent role orchestration without introducing
    tool calls. Retain the existing three-attempt JSON extraction/repair/Zod
    behavior instead of stacking another repair loop. Update safe config status
    labels. Run unit tests, lint, typecheck, build, and one live
    `normalizeMotion` marker call; do not run the full debate API or evidence
    search workflow.

15. **Repair hamoneyos compile chat and replace two Claude CLI Agents.**

    Primary files:

    - `/Users/caoxiaopeng/wiki/hamoneyos/99_Scripts/compile_vault.py`
    - `99_Scripts/query_vault.sh`
    - `99_Scripts/lint_vault.sh`
    - New focused helper/shell tests under `99_Scripts/tests/`

    Move compile text/PNG/JPEG chat to agent-im with remote/MIME rejection.
    Replace query synthesis and `--deep` analysis Claude invocations with a
    shared constrained Codex CLI helper implementing the approved executable,
    model, timeout, cancellation, error, and output contracts. Preserve all
    structural lint behavior and opt-in save behavior. Test helpers with
    temporary output, run a query without `--save`, and exercise deep analysis
    without persisting a report.

16. **Make github-search's active RAG/translation Agent use its existing Codex client.**

    Primary files:

    - `/Users/caoxiaopeng/github-search/scripts/codex-cli-client.js`
    - New typed adapter `lib/codex-agent.ts`
    - `lib/repository-analyzer.ts`
    - `lib/translation.ts`
    - `lib/langchain-utils.ts`
    - `start.sh`
    - Existing Codex tests plus entry-point tests for all three consumers

    Keep the proven Codex subprocess implementation, add `CODEX_BIN`/
    `CODEX_MODEL` compatibility behind the approved project-specific
    precedence, and update only the automatic consumer imports/calls. Preserve
    Cursor client files for explicit use. Run Codex client unit tests, an
    entry-point test for repository analysis, translation, and RAG, project
    typecheck/build, and one real read-only preflight. Do not index a repository.

17. **Change only MacVoiceCode's fresh-install default to Codex.**

    Primary files:

    - `/Users/caoxiaopeng/ios/macvoicecode/Sources/macvoicecode/Models.swift`
    - `Sources/macvoicecode/RunnerStore.swift`
    - `Tests/macvoicecodeTests/ParserTests.swift` or a new focused store test

    Put `codex-default` first and use it as the empty/fresh fallback while
    preserving every provider profile. Before and after the change, read only
    the selected runner ID from the user runtime config and assert it remains
    `cursor-default`. Run `swift test` and a direct read-only Codex runner smoke;
    do not rewrite the runtime JSON or paired-iPhone settings.

18. **Verify blog2media without changing its provider behavior.**

    Primary targets:

    - `/Users/caoxiaopeng/Desktop/git/blog2media/.env` sanitized resolution
    - `config.env.example`
    - `lib/llm-fallback.ts`
    - `lib/strategies/MediumStrategy.ts`

    Confirm the active route still resolves `MEDIUM_DEMO_PROVIDER=openai` and
    loopback agent-im without printing keys. Run the existing safe client/unit
    smoke. Do not rewrite the working default or remove optional Claude and
    working fallback implementations.

19. **Switch agent-im's active bridge/research routing to existing Codex runner `rt-6`.**

    External configuration target:

    - `/Users/caoxiaopeng/Library/LaunchAgents/com.claude-to-im.bridge.plist`
    - Service label `com.claude-to-im.bridge`

    Create a timestamped local backup. Apply a targeted transformation to only
    `EnvironmentVariables.CTI_DEFAULT_RUNNER`, `CTI_RUNTIME`,
    `CTI_IM_BOT.defaultRunnerId`, and both
    `CTI_RESEARCH.{researcherRunner,reviewerRunner}` entries. Reuse the existing
    `rt-6` Codex-login runner definition and preserve the runner inventory,
    tokens, all unrelated environment keys, ownership, and permissions. Produce
    only a sanitized before/after routing diff. Validate plist syntax, reload
    only `com.claude-to-im.bridge`, confirm service health, then run real marker
    calls through default, researcher, and reviewer routing. On failure, restore
    the backup and reload the same service.

20. **Run the global regression and dead-route scan.**

    Re-run each changed repository's focused tests and available typecheck/build
    command. Search active defaults and automatic fallback chains for the exact
    failed endpoints/models/providers recorded in the audit. Separately confirm
    that preserved implementations may be reached only by explicit selection,
    excluded device/cloud files have no diff, podcast audio and news-market
    embeddings never point at agent-im, and MacVoiceCode still selects Cursor
    in its current runtime config.

21. **Produce the final verification report.**

    Write a user-facing Markdown report under
    `/Users/caoxiaopeng/Documents/Codex/2026-08-30/agent-cli-sdk-llm-api/outputs/`
    containing, per project: route class, changed files, sanitized resolved
    provider/base/model, exact safe test commands, exit/result, real-smoke
    marker, unchanged paths, and unsupported residuals. Include a separate
    failure section for anything not fully recovered; never count U-class audio,
    embeddings, remote images, or native Responses state as repaired.

## Open Questions

None blocking. The approved assumptions are:

- Scheme 1 remains the governing scope: working routes and explicit working
  user selections are preserved.
- The only cross-class fallback is dailyreport/wiki Codex primary to agent-im.
- agent-im remains loopback-only and its compatibility bearer is non-secret.
- Unsupported audio, embeddings, remote image URLs, and native Responses state
  remain explicit residuals.

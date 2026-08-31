# Failed Agent and LLM Route Migration Design

Date: 2026-08-31  
Status: Independently reviewed and approved; pending user review and implementation plan

## Goal

Repair only the Agent and LLM routes that failed in the 2026-08-31 M4 audit:

- A failed local OpenAI-style text or supported vision route becomes an
  `agent-im` Chat Completions route.
- A failed local CLI Agent route becomes a direct Codex CLI route.
- A working route, including a working explicitly selected Cursor, Ark,
  WebGemini, OpenCode, or existing agent-im route, remains unchanged.

This is not a provider consolidation. It does not move iOS devices, HarmonyOS
devices, AGC functions, or deployed cloud services to `127.0.0.1`.

## Source and Capability Evidence

Scope was derived from:

- `/Users/caoxiaopeng/Desktop/M4-项目与自动化清单-2026-08-30.md`
- `/Users/caoxiaopeng/Documents/Codex/2026-08-30/agent-cli-sdk-llm-api/outputs/项目Agent-CLI-SDK-LLM-API调用验证报告-2026-08-31.md`
- Read-only inspection of every active entry point listed in the project matrix
  below.

The following `agent-im` compatibility baseline was verified against the live
service on 2026-08-31, using model `codex-login/gpt-5.5`:

| Capability | Verified result | Migration consequence |
|---|---|---|
| Non-streaming text | `object=chat.completion`, non-empty `choices[0].message.content` | Supported |
| SSE text | `Content-Type: text/event-stream`, content `STREAM_OK`, terminal `[DONE]` | Existing stream consumers may be retained |
| PNG data-URL image input | Existing PNG plus text returned `VISION_OK` | Supported for local PNG data URLs |
| JPEG data-URL image input | PNG converted to JPEG plus text returned `JPEG_OK` | Supported for local JPEG data URLs |
| Remote image URL | agent-im represents it as text rather than fetching/attaching it | Unsupported |
| Native Responses API state | No native endpoint/contract | Unsupported |
| Tools/functions/reasoning items | No compatible execution contract | Unsupported |
| Audio transcription | No compatible endpoint | Unsupported |
| Embeddings | No compatible endpoint | Unsupported |
| Native JSON Schema enforcement | No compatible guarantee | Application validation is required |

OpenAI currently recommends Responses for native reasoning and multi-turn
applications. These repairs deliberately use Chat Completions because that is
the verified local `agent-im` contract and the in-scope workloads do not require
native Responses state. A caller that does require such state is rejected or
left as an explicit residual; it is not silently downgraded.

## Non-Negotiable Constraints

- Change only failed paths and failed fresh-install or automatic defaults.
- Preserve working providers and explicit working user selections.
- Keep agent-im bound to the local machine; do not publish port 3300.
- Do not add, rotate, print, or commit real credentials.
- Preserve unrelated uncommitted work in every repository.
- Do not execute publishing, trading, deletion, messaging, database mutation,
  vault compilation, or bulk-write workflows during verification.
- Do not claim recovery of audio, embeddings, remote-image fetching, tool
  calling, or native Responses continuation.

## Route Classes and Boundary

Every touched path belongs to exactly one class:

- **A — agent-im API:** Local programmatic Chat Completions. It calls
  `http://127.0.0.1:3300/v1/chat/completions`; it does not spawn Codex CLI.
- **B — local Codex Agent:** Local interactive/agentic work. A B1 entry invokes
  Codex CLI directly; a B2 entry uses `@openai/codex-sdk` with a local Codex CLI
  wrapper. Neither calls agent-im's HTTP compatibility endpoint.
- **C — preserve/verify:** The active route already works, so no behavior change
  is made. Verification prevents accidental regression.
- **U — unsupported residual:** A capability such as Whisper transcription or
  embeddings cannot be supplied by the verified agent-im contract and remains
  explicitly unavailable or unchanged.

A project may contain more than one class, but a single entry point may not
switch between class A and B implicitly. Fallbacks are allowed only where the
matrix explicitly names them.

## Runtime Contracts

### Class A: agent-im Chat Completions

The repaired default request is:

```text
POST http://127.0.0.1:3300/v1/chat/completions
Content-Type: application/json
Authorization: Bearer local-agent-im

{
  "model": "codex-login/gpt-5.5",
  "messages": [...],
  "stream": false
}
```

The compatibility bearer value is non-secret and exists only for SDKs that
require a non-empty key. No authorization decision depends on it.

Class A configuration is:

```text
AGENT_IM_BASE_URL=http://127.0.0.1:3300/v1
AGENT_IM_MODEL=codex-login/gpt-5.5
AGENT_IM_API_KEY=local-agent-im
AGENT_IM_TIMEOUT_SECONDS=180
```

Precedence is deterministic:

1. Explicit `AGENT_IM_*` value.
2. The default shown above.

Legacy `OPENAI_*`, `ARK_*`, `DEEPSEEK_*`, or project-specific variables do not
override the repaired automatic route. They remain usable only behind an
explicit provider choice that already exists and is listed as preserved. A
project may keep old exported symbol names internally to minimize diffs, but
the values for the repaired default are resolved from `AGENT_IM_*`.

An SDK base URL ends in `/v1`; raw HTTP appends `/chat/completions` exactly
once. Health URL derivation removes one trailing `/v1` and appends `/health`,
so the default resolves to `http://127.0.0.1:3300/health`.

### Class B: Local Codex Agent

Executable resolution order is:

1. If non-empty `CODEX_BIN` is explicitly configured, use exactly that path.
   A missing or non-executable explicit value is a configuration failure; it is
   not silently skipped.
2. Otherwise use `/Applications/ChatGPT.app/Contents/Resources/codex` when it is
   executable.
3. Otherwise resolve `codex` from `PATH`, or fail if it is absent.

Model precedence is: a documented project-specific Codex model variable,
`CODEX_MODEL`, then `gpt-5.5`. Timeout precedence is: a documented
project-specific Codex timeout variable, `CODEX_TIMEOUT_SECONDS`, then 300.
Whitespace-only values are absent. A non-empty invalid model, or a timeout that
is not an integer from 1 through 1800, is a configuration failure and does not
fall through. The invocation is non-interactive, read-only or otherwise
constrained to the workflow's existing permissions, and uses the intended
project working directory.

Touched B1 direct-CLI wrappers must implement or reuse these semantics:

- 300-second default timeout, configurable per project.
- Forward cancellation; on timeout/cancel send `SIGTERM`, then `SIGKILL` after
  five seconds if the process remains alive.
- Treat missing executable/login, non-zero exit, empty final output, and output
  contract violations as explicit failures.
- Retry at most two times after the first attempt only for classified transient
  network, 429, or 5xx failures. Do not retry auth/configuration failures or an
  unclassified non-zero exit.
- Limit included stderr to 4 KiB and redact credential-like values.

`github-search` already contains a tested Codex wrapper with these behaviors;
other class B entries reuse their existing Codex runner where possible rather
than inventing a second protocol.

The following per-entry table is authoritative and overrides the generic B1
defaults where it says otherwise. Each arrow means “first
non-empty value wins,” and an explicit invalid winner fails without trying the
next value:

| Entry | Executable | Model | Timeout |
|---|---|---|---|
| `github-search` | `CODEX_CLI_PATH` → `CODEX_BIN` → ChatGPT bundled Codex → `PATH` | `GITHUB_SEARCH_CODEX_MODEL` → `CODEX_MODEL` → `gpt-5.5` | call option → `CODEX_TIMEOUT_SECONDS` → 300s |
| `dailyreport/wiki/codex_synthesize.sh` | `CODEX_BIN` → bundled Codex → `PATH` | `CODEX_SYNTH_MODEL` → `CODEX_MODEL` → `gpt-5.5` | positional timeout → `CODEX_CLI_TIMEOUT_SECONDS` → `CODEX_TIMEOUT_SECONDS` → 300s |
| `hamoneyos` query/deep helpers | `CODEX_BIN` → bundled Codex → `PATH` | `HAMONEYOS_CODEX_MODEL` → `CODEX_MODEL` → `gpt-5.5` | `HAMONEYOS_CODEX_TIMEOUT_SECONDS` → `CODEX_TIMEOUT_SECONDS` → 300s |
| MacVoiceCode (B1) | selected runner profile's executable only | request model → profile model → Codex login default | existing `CLIProcessRunner` cancellation plus 45s speech-format guard; unchanged by this migration |
| agent-im LaunchAgent (B2) | existing `CodexProvider` loads `@openai/codex-sdk` with `scripts/codex-wrapper.sh` as `codexPathOverride`, which starts the local Codex CLI | `rt-6.defaultModel` (`gpt-5.5`) | existing agent-im runner cancellation/timeout/stream-safety contract; unchanged by this routing-only migration |

Timeout variables use seconds and the 1–1800 validation rule. The github-search
call option remains milliseconds at its public JavaScript boundary and is
validated before conversion.

## Per-Project Scope Matrix

| Project root | Class | Active entry points | Required change | Supported result | Explicit residual / preserved behavior | Safe real smoke |
|---|---:|---|---|---|---|---|
| `/Users/caoxiaopeng/Desktop/football` | A | `apps/sports-analytics-web/app/lib/openai-llm.ts`, `harmony-news-translation.ts` | Make the failed automatic local text route agent-im Chat Completions; retain existing validation/logging | Text translation/generation | Explicit non-system Kimi tooling remains optional | Existing two targeted tests plus one client call returning a fixed marker; no app data write |
| `/Users/caoxiaopeng/Desktop/git/crawlers` | A+U | `crawlers/sites/podcast/transcribe.py`, `wechat/wechat.py`, `rednote/rednote.py` | Route chat summarization/title/extraction helpers to agent-im | Text chat helpers | Podcast audio transcription remains U and is not reported repaired | Invoke each distinct summary helper with fabricated in-memory text; never crawl or write DB/cache |
| `/Users/caoxiaopeng/Desktop/githubsync` | A | `oneapi.py`, `vol_test.py` | Replace dead/mismatched default endpoint, key variable, and model with agent-im; preserve the existing stream demonstration because SSE is verified | Non-stream and SSE text | No Ark claim remains in the repaired default | Run both scripts with marker prompts; no repository mutation |
| `/Users/caoxiaopeng/DevEcoStudioProjects/bitstripe` | A | `huawei/llm.py`, `composer/llm-composer-server.mjs`, `composer/start-llm-composer.sh`; current callers in `codecrew/views.py` and `kousou/views.py` | Route text/JSON/data-URL vision/SSE to agent-im; convert Composer Responses call; deterministically fix startup to launch `composer/llm-composer-server.mjs` from its real location | Text, SSE, application-validated JSON, data-URL images | Remote URLs and native schema enforcement unsupported | Unit-level text/stream/image checks; start Composer on a temporary port, check `/health`, POST harmless `/v1/compose` fixture |
| `/Users/caoxiaopeng/DevEcoStudioProjects/newbrowser` | A | `scripts/llm-composer-server.mjs`, `scripts/start-llm-composer.sh` | Convert Responses+schema call to agent-im Chat Completions and application JSON validation; default startup config to agent-im | Text and validated Composer JSON | `entry/.../LlmComposerClient.ets` device settings unchanged | Temporary-port `/health` and harmless `/v1/compose`; no device change |
| `/Users/caoxiaopeng/m2-futures-migration/Desktop/dailyreport/study-app` | A | `src/lib/server-env.ts`, `src/lib/openai-client.ts`, `src/app/api/quiz/generate/route.ts`, `src/app/api/quiz/grade/route.ts` | Replace invalid DeepSeek automatic client with agent-im and remove reliance on native `response_format` | Application-validated quiz JSON | Supabase/rate-limit behavior unchanged | Entry-point integration test for each route that reaches the real agent-im client while stubbing only Supabase/rate-limit writes; no persistent business mutation |
| `/Users/caoxiaopeng/m2-futures-migration/Desktop/dailyreport/wiki` | A+B | `99_Scripts/compile_vault.py`, `99_Scripts/codex_synthesize.sh` | Make compile helper use agent-im; keep Codex synthesis primary and replace its multi-config dead fallback with one explicit agent-im fallback | Text and data-URL image chat; Codex synthesis | Full vault compilation remains outside smoke | Import/call LLM helper in isolation; run synthesis with temporary prompt/output and verify primary provider marker, then controlled bad `CODEX_BIN` to verify agent-im fallback |
| `/Users/caoxiaopeng/m2-futures-migration/Desktop/futures` | A | `util/llm_client.py`, `auto/util/llm_client.py`, `scripts/summarize_news_llm.py` | Replace banned proxy/default with agent-im | Text analysis/summarization | Working Codex automations remain unchanged | Each distinct client/helper with fabricated news; do not run `main` that rewrites `news.json` |
| `/Users/caoxiaopeng/m2-futures-migration/Documents/Codex/2026-06-29/gao` | A | `scripts/agent_review_runner.py` provider `openai`/`auto` | Convert its concrete system text + user text + data-URL image request from Responses to Chat Completions; make automatic API route agent-im | Text plus local chart image | Explicit Gemini and Codex CLI providers remain; unsupported Responses item types are rejected | Direct `call_openai` marker call using an existing preview image; do not run batch or write review outputs |
| `/Users/caoxiaopeng/service/truth-debate-arena` | A | `lib/server/claude-config.ts`, `lib/debate/ai-runtime.ts` | Replace insufficient-balance Anthropic provider with an OpenAI-compatible AI SDK provider configured for agent-im; retain application JSON extraction/Zod repair | Structured debate JSON without tools | Evidence search and debate orchestration remain; no tool execution is introduced | Unit/config tests, typecheck/build, then one `normalizeMotion` marker call; do not run the full debate API |
| `/Users/caoxiaopeng/wiki/hamoneyos` | A+B | `99_Scripts/compile_vault.py`, `query_vault.sh`, `lint_vault.sh --deep` | Route compile chat/vision to agent-im; replace failed Claude synthesis/deep-analysis CLI calls with Codex CLI | Text, data-URL image, Codex query/deep analysis | Structural lint unchanged; saving is opt-in and excluded from smoke | Isolated compile helper; query without `--save`; deep agent helper with temporary output, not report persistence |
| `/Users/caoxiaopeng/Desktop/git/chrome-dev-mcp-server` | A+U | `skills/miracleplus-database/scripts/fetch_and_summarize.py` | Point only the optional database skill's chat summarization/topic synthesis at agent-im | Text summaries | Core MCP unchanged; `news-market` embeddings remain U and are not moved to agent-im | Call summary/topic functions with fabricated records; no database fetch/cache/report write |
| `/Users/caoxiaopeng/github-search` | B | `lib/repository-analyzer.ts`, `lib/translation.ts`, `lib/langchain-utils.ts`, existing `scripts/codex-cli-client.js`, `start.sh` | Add a thin typed Codex adapter over the existing client, update all three consumer imports/calls, and make it the automatic RAG/translation Agent | Codex repository analysis, translation, and RAG | Cursor client files remain explicitly usable because Cursor passed the audit | Existing Codex client unit tests plus one entry-point test for each of repository analysis, translation, and RAG that resolves/invokes the real Codex adapter; one read-only marker preflight; no indexing write |
| `/Users/caoxiaopeng/Desktop/git/blog2media` | C | `.env`, `config.env.example`, `lib/llm-fallback.ts`, `MediumStrategy.ts` | No code change: actual `.env` already selects `MEDIUM_DEMO_PROVIDER=openai` and `127.0.0.1:3300/v1` | Existing agent-im route | Optional Claude branch and working fallbacks remain | Resolve sanitized provider/base/model and run existing safe agent-im client smoke only |
| `/Users/caoxiaopeng/ios/macvoicecode` | B+C | `Sources/macvoicecode/Models.swift`, `RunnerStore.swift`; user runtime `runners.json` | Put Codex first/make `codex-default` the fresh-install fallback | Fresh installs default to Codex | Existing runtime selection is `cursor-default` and must not be overwritten; provider menu and paired-iPhone settings remain | `swift test` plus direct read-only Codex runner smoke; assert runtime selection remains Cursor |
| `/Users/caoxiaopeng/service/agent-im` | B | plist `/Users/caoxiaopeng/Library/LaunchAgents/com.claude-to-im.bridge.plist`, service label `com.claude-to-im.bridge`, existing runner `rt-6` | Target only `EnvironmentVariables.CTI_DEFAULT_RUNNER`, `CTI_RUNTIME`, `CTI_IM_BOT.defaultRunnerId`, and `CTI_RESEARCH.researcherRunner`/`reviewerRunner`; point them to `rt-6`/Codex while preserving the runner inventory and every unrelated plist value | Default/research Agent calls use Codex login | Claude/Copilot/Cursor implementations and secrets remain untouched | Sanitized routing-key readback, `launchctl` restart/status for the exact label, real default/researcher/reviewer marker calls |
| `/Users/caoxiaopeng/DevEcoStudioProjects/kousou-harmonyos` | C | existing bitstripe receipt endpoint client | No device code change; verify indirect recovery after bitstripe repair | Existing bitstripe integration | No direct agent-im URL on device | Harmless local receipt endpoint fixture; no device deployment |

## Explicitly Unchanged

- `/Users/caoxiaopeng/Desktop/AIGoCoach-iPad`
- `/Users/caoxiaopeng/DevEcoStudioProjects/CuotiBao`
- deployed provider routes in `Desktop/ziwei-compass-server`
- device/cloud provider settings in iOS, HarmonyOS, and AGC code
- working Ark paths in `python_house`, `website-scraper`,
  `options-quant-paper`, and `loneweibo`
- WebGemini and the Douyin crawler's working WebGemini/Codex behavior
- PoseMuse agent-im ImageGen
- working explicit Cursor and OpenCode integrations

## Request and Response Adaptation

### OpenAI SDK and Raw HTTP Callers

SDK callers keep their existing message construction, but their repaired route
uses `AGENT_IM_*`. Raw HTTP callers post to `/chat/completions` and read
`choices[0].message.content`.

All class A callers must:

- Require at least one choice and a non-empty assistant string.
- Surface a redacted agent-im error body for non-2xx responses.
- Not rely on `temperature`, `top_p`, token limits, `response_format`, hosted
  tools, or provider-specific reasoning fields being honored.
- Remove unsupported parameters when their presence causes an SDK or local
  compatibility failure; otherwise treat them as hints only, never guarantees.

### Exact Responses Conversion Boundary

Only the concrete in-scope Responses shapes are converted:

- Ordered `system`, `user`, and `assistant` text become ordered chat messages.
- `input_text` becomes text content.
- `input_image` is accepted only for a `data:image/png;base64,...` or
  `data:image/jpeg;base64,...` URL on a user message and becomes Chat
  Completions `image_url` content. Every other image MIME is rejected.

The adapter must reject, with an actionable unsupported-capability error:

- `previous_response_id` or any request that depends on server-side history.
- Tool/function calls or results.
- Reasoning, computer-use, file, audio, refusal, or unknown item types.
- Remote image URLs.
- Non-text assistant payloads.

The current gao and Composer callers use only the supported subset. The
conversion does not create a generic Responses polyfill and does not silently
drop unknown items.

### Structured JSON

agent-im does not guarantee native JSON Schema enforcement. New conversion
adapters therefore:

1. Ask for one JSON object only and include a concise schema description.
2. Strip at most one outer Markdown code fence.
3. Parse and validate with the project's existing Zod/schema validator.
4. On failure, make at most one repair request containing a bounded invalid
   output and validation summary.
5. Fail explicitly if the repair is invalid.

`truth-debate-arena` already has a bounded three-attempt structured retry with
Zod validation and JSON repair. That existing behavior is preserved rather
than layered with another repair loop.

### Streaming and Images

Existing SSE consumers in githubsync and bitstripe may remain streaming because
the live agent-im stream contract was verified. No new workflow is converted to
streaming merely for this migration.

Local image callers may send PNG/JPEG data URLs; both formats were verified.
Remote image URLs must be
downloaded and validated by pre-existing trusted application logic before the
LLM call, or rejected; this migration does not add a downloader.

## Error Handling and Availability

For class A HTTP calls:

- A one-shot helper makes the LLM request directly so health checking does not
  double its latency.
- A long-running batch or local service performs one startup preflight against
  the derived `/health` URL before its sequence of LLM calls.
- `AGENT_IM_BASE_URL` must be an absolute HTTP(S) loopback URL with no query or
  fragment and with path `/` or `/v1` (trailing slash allowed). It normalizes to
  `/v1`; other hosts or paths are rejected. Health is successful only for a 2xx
  JSON response whose top-level `ok` is `true`.
- Connection failures, 429, and 5xx responses receive at most three total
  attempts. Default waits are one then two seconds. A numeric `Retry-After` is
  accepted, clamped to 0 through 10 seconds, and the wait is the larger of the
  default backoff and the clamped value; HTTP-date or invalid forms are ignored.
- Other 4xx responses do not retry.
- Default timeout is 180 seconds; a known long-running batch may explicitly
  increase it.
- Errors include project operation, endpoint host, model, status/exit code, and
  a bounded redacted provider message. They exclude headers, keys, tokens, and
  full sensitive prompts.
- A repaired default never falls through to a provider already confirmed dead,
  banned, out of balance, or policy denied.

If agent-im is unavailable, class A reports how to check
`http://127.0.0.1:3300/health`. A class A entry never falls back to class B.
The only cross-class fallback is the opposite direction in
`dailyreport/wiki/99_Scripts/codex_synthesize.sh`: its explicit Codex CLI
primary (B) may fall back to agent-im (A). The class A `compile_vault.py` helper
never falls back to Codex.

## Implementation and Safety Order

1. Record `git status --short` in every repository and identify all pre-existing
   changes. Never clean, reset, or overwrite unrelated work.
2. Reconfirm agent-im health, text, SSE, data-URL image, Codex login, and the
   Web/API LaunchAgent.
3. Repair simple class A clients and add adapter/config tests.
4. Repair Composer/service chains and run temporary-port smokes.
5. Repair class B entry points and fresh-install defaults.
6. Update agent-im LaunchAgent routing fields using a targeted parser that
   preserves every unrelated plist key and secret; reload only the named
   service after a backup and sanitized diff.
7. Verify class C paths have no behavior diff.
8. Scan active defaults for the confirmed-dead endpoints/models and produce a
   per-project report.

## Verification Strategy

### Static and Unit Verification

For every changed repository:

- Run the closest formatter, syntax compiler, type checker, and focused tests.
- Test default and explicit environment resolution.
- Test accepted and rejected Responses item types where an adapter exists.
- Test JSON parse, one-repair success, terminal failure, empty output, timeout,
  cancellation, non-zero exit, 4xx no-retry, and transient retry as applicable.
- Exercise shell/service/CLI wrappers, not only a shared internal client.
- Confirm excluded device/cloud files and preserved provider implementations
  have no diff.

### Real Safe Smokes

The final column of the project matrix is mandatory. Each active entry point is
either invoked directly with a harmless marker/fixture or covered by an
entry-point-level test that reaches its real client. Shared low-level client
success alone is insufficient.

All temporary servers use unused loopback ports. All output files use a
temporary directory. The smokes do not publish, trade, message, deploy, crawl,
write production databases, save vault queries, compile whole vaults, or mutate
user runtime selections.

Failure smokes use an unreachable loopback port or controlled bad executable
path and assert the defined error and absence of dead-provider fallback. For
`codex_synthesize.sh`, an explicit non-executable `CODEX_BIN` must fail its
class B primary and intentionally exercise its documented B-to-A fallback; in
all other class B entries, the same configuration error is terminal.

### Acceptance by Route Class

Class A is accepted only when:

- Every migrated default resolves to the agent-im base/model contract.
- Its real entry-point smoke returns non-empty chat content or schema-valid JSON.
- Existing SSE/image callers pass their respective real capability smoke.
- Unsupported audio, embeddings, remote images, and Responses state remain
  clearly identified rather than reported recovered.

Class B is accepted only when:

- Every changed failed Agent default resolves to a logged-in Codex runner.
- Its real wrapper/entry-point smoke produces non-empty output and passes
  timeout/exit/error tests.
- Working explicit provider choices and MacVoiceCode's current Cursor selection
  are preserved.

Class C is accepted only when sanitized resolution and smoke evidence confirms
the existing working route, with no unnecessary behavior change.

Class U is accepted only when:

- Podcast transcription still calls its existing audio path or reports it
  unavailable; it never sends audio to agent-im Chat Completions.
- `news-market` embeddings remain on their existing explicitly configured
  embedding provider or fail with their existing configuration error; they
  never call agent-im's chat route as an embedding substitute.
- Every migrated image-input boundary, including ordinary Chat Completions
  callers in bitstripe and both vault compilers, has a negative test proving a
  remote URL and an unverified image MIME are rejected. Responses adapters also
  prove that previous-response state, tools/functions, audio, files, reasoning,
  and unknown item types are rejected rather than silently discarded.
- Tests and the final report name each residual as unsupported/not migrated and
  never include it in the recovered count.

Across all classes:

- No confirmed-dead provider or endpoint appears at any position in a repaired
  automatic route or automatic fallback chain. A preserved provider can run
  only after explicit user/provider selection.
- No credential is added to Git or emitted in logs/reports.
- The final report lists changed files, exact safe commands, results, unchanged
  paths, and every U residual.

## Rollback

Each repository remains independently reversible. Code changes are small local
adapters/config resolvers rather than a cross-repository package.

Before changing the agent-im LaunchAgent, make a timestamped local backup.
Rollback restores only the targeted routing fields (or the backup if targeted
restoration fails) and reloads that one service. Provider inventories,
credentials, Git history, and unrelated LaunchAgent settings are never deleted
or rewritten.

## Security Notes

The agent-im compatibility route is currently unauthenticated and remains
loopback-only. A future LAN/remote deployment requires authentication, TLS,
rate limits, and a separately reviewed trust boundary.

Previously discovered plaintext credentials are not copied into new files.
Credential rotation and Git-history cleanup are separate tasks and are not
implicitly authorized by this migration.

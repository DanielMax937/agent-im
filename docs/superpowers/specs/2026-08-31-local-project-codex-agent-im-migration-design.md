# M2 本地项目 Agent 与 LLM 调用迁移设计

- 日期：2026-08-31
- 状态：已完成方案评审，待实施计划
- 适用主机：M2（当前机器）
- 核心服务：`/Users/daniel/service/agent-im`

## 1. 背景与目标

M2 项目清单与实测结果显示，部分项目仍引用已经不可用或已卸载的 Agent CLI，另有部分文本生成调用指向余额不足、密钥失效、账号被禁用或协议配置错误的 LLM 上游。与此同时，Codex CLI、Cursor Agent、Volcengine Ark、NVIDIA API 以及本机 `agent-im` 的 Codex SDK 链路仍可正常工作。

本次迁移的目标是：

1. 只替换已经确认无法调用、且确实参与项目执行的 Agent 或文本生成链路。
2. 将失效的 Agent CLI 调用迁移到 `codex exec`。
3. 将适合 OpenAI Chat Completions 协议的失效文本生成调用迁移到本机 `agent-im` 接口。
4. 保持当前可用的服务、生产部署与提供商专用研究项目不变。
5. 不把密钥写入 Git，不把只监听本机用途的接口错误地带入公开部署。

本次设计不以“统一所有模型调用”为目标，而是以最小改动恢复本地项目的可运行性，并保留每个项目原有的业务语义和生产边界。

## 2. 已确认的现状

### 2.1 可正常调用，保持不变

- Codex CLI。
- Cursor Agent CLI。
- `agent-im` 的 Codex SDK/login 链路。
- Volcengine Ark 文本模型。
- NVIDIA API。
- 项目中已验证可用、且不依赖下述失效配置的本地离线流程。

### 2.2 已确认失败

- Claude CLI：当前配置转发到 DeepSeek，上游返回 HTTP 402，余额不足。
- OpenCode：同一 DeepSeek 上游返回 HTTP 402。
- Copilot CLI：GitHub 组织或账号策略拒绝使用。
- Gemini CLI、Qwen Code：本机已卸载。
- MiraclePlus 代理：HTTP 403，账号被禁用。
- Gemini API：HTTP 403，密钥已暂停。
- DeepSeek API：HTTP 402，余额不足。
- Round Table 当前上游：HTTP 401，无效密钥。
- `ai_tools` 中 Ark 配置：HTTP 401，密钥格式错误。
- 官方 OpenAI 配置：HTTP 401，无效密钥。
- DataPlatform LLM 配置：将 Anthropic URL 当作 OpenAI Chat Completions 端点使用，返回 HTTP 404。
- Ollama：本机没有可用服务。

失败状态是本次迁移的输入条件。实施前的短暂健康检查若发现某个原配置已经恢复，则遵循“能通不改”的原则，不迁移该调用。

## 3. 设计原则与边界

### 3.1 必须遵守的原则

1. **能通不改**：可用的 Codex、Cursor、Ark、NVIDIA 或其他现有调用保持原样。
2. **本地优先**：默认只改 M2 本地开发和本地执行配置。
3. **生产隔离**：Vercel、iOS、Cloudflare 等公开部署不指向 `127.0.0.1`，现有生产配置保持不变。
4. **最小适配**：优先复用项目已有 OpenAI-compatible 客户端或环境变量，不进行无必要的框架重写。
5. **语义真实**：多模型研究项目不能把不同供应商名称全部偷偷映射成同一个 Codex 模型，否则会破坏实验结论。
6. **密钥安全**：只提交变量名、示例和文档；真实密钥保留在未跟踪的本地环境文件或系统服务环境中。
7. **保留现场**：各项目现有未提交修改属于用户；实施时逐项目小范围修改，避免覆盖或混入无关变更。

### 3.2 明确不在本次范围内

- 不改 `gemini-rate-limit-demo`、`qwen-redteam-suite` 等提供商专用演示或红队项目。
- 不用 Agent-im/Codex 替代 embedding、图像生成、语音、Whisper、Ollama 本地模型等专用能力。
- 不修改文档、缓存、历史会话、测试夹具中仅作为文本出现的 `claude`、`opencode`、`gemini` 等字符串。
- 不执行公开部署，不改远程生产环境变量。
- MemOS、GEOFlow、`ai_tools`、`go` 本轮不修改：扫描结果没有证明它们当前存在一个必须恢复的、已失败的真实执行入口；其中 `go` 在没有在线 LLM 时已有明确的结构化模板降级。
- `aiacounting`、`qiaomu`、`math-manim`、`zai`、`cloudflare-os` 本轮不修改：它们属于公开部署候选，而本次没有一个已确认需要恢复的本地运行入口。这样可以直接保证生产构建和部署配置零变化。
- 不批量重写任何多提供商框架。若后续实测确认上述排除项的本地入口失败，再作为新的、独立范围设计本地 profile。
- 不在本次工作中修复与 Agent/LLM 迁移无关的依赖缺失或业务逻辑错误；这些问题会单独列为验证阻塞项。

## 4. 目标架构

本地文本生成的目标数据流为：

```text
本地项目/脚本
    │
    ├─ 现有可用供应商客户端 ──────────────> 原可用上游（保持不变）
    │
    └─ OpenAI-compatible SDK / HTTP 客户端
                      │
                      v
             http://127.0.0.1:3300/v1
                      │
                      v
               agent-im Web/API
                      │
                      v
              Codex SDK / Codex login
```

Agent CLI 的目标数据流为：

```text
本地脚本 ──> codex exec（只读沙箱、临时会话）──> Codex login
```

`agent-im` 继续只作为本机可信开发接口使用。当前服务实际监听 `*:3300` 且没有 API 鉴权，这与“仅本机”目标不一致。因此，任何项目切换到该接口前，必须先让 PM2 的 Next.js 启动命令显式使用 `-H 127.0.0.1`，使有效监听地址变成 `127.0.0.1:3300`。变更位置限定为 `/Users/daniel/service/agent-im/ecosystem.config.cjs`，不修改 `/Users/daniel/Library/LaunchAgents/com.agent-im.web.plist`。

安全验收必须同时满足：

- `lsof -nP -iTCP:3300 -sTCP:LISTEN` 只显示 loopback 监听，不显示 `*`、`0.0.0.0` 或局域网地址。
- `curl http://127.0.0.1:3300/health` 成功。
- 使用 M2 的局域网 IP 访问 3300 失败。

如果用户以后需要从局域网访问 Agent-im，必须另行设计鉴权和网络访问控制；本次不得为了兼容 LAN 而继续保留无鉴权的全接口监听。

## 5. 本地配置契约

通用本地配置使用下列语义：

```dotenv
LLM_PROVIDER=agent-im
AGENT_IM_BASE_URL=http://127.0.0.1:3300/v1
AGENT_IM_MODEL=codex-login/gpt-5.5
AGENT_IM_API_KEY=local-only
```

实施时按第 7 节的确定映射写入各项目已经被 Git 忽略的本地 `.env`，避免为了统一变量名而改动已有 OpenAI-compatible 客户端。

约束如下：

- `AGENT_IM_API_KEY` 只是满足部分 OpenAI SDK 的非空参数校验；本机 Agent-im 当前不依赖它鉴权。
- `.env.example` 可以记录占位值和说明；真实 `.env` 必须保持未跟踪。
- 本地覆盖文件应具有高于默认配置、低于显式命令行参数的优先级。
- 本轮纳入实施的项目均为 M2 本地项目，不向 Vercel、iOS、Cloudflare 或其他部署环境添加 `LLM_PROVIDER`。
- 本轮明确排除所有公开部署候选，因此不会新增任何可能进入部署 artifact 的 Agent-im 配置文件、环境变量或分支代码。

## 6. Agent CLI 迁移

### 6.1 Knowledge Vault 查询脚本

以下五个脚本存在真实的 `claude --print` 执行路径：

- `/Users/daniel/Documents/KnowledgeVaults/kaggle/99_Scripts/query_vault.sh`
- `/Users/daniel/Documents/KnowledgeVaults/startups/99_Scripts/query_vault.sh`
- `/Users/daniel/Documents/KnowledgeVaults/substack/99_Scripts/query_vault.sh`
- `/Users/daniel/Documents/KnowledgeVaults/wechat/99_Scripts/query_vault.sh`
- `/Users/daniel/Documents/Obsidian Vault/99_Scripts/query_vault.sh`

这些调用改为同一套 shell 行为契约：

- 工作目录固定为对应 vault 根目录。
- 完整提示词通过 stdin 传递，以 `-` 作为 `codex exec` 的 prompt 参数，避免 shell 参数长度和转义问题。
- 固定命令选项为 `--sandbox read-only --ephemeral --skip-git-repo-check --color never`；同时禁用已安装 CLI 中的 browser、in-app browser、apps 与 standalone web-search 功能。Codex 自身仍需要联网访问模型服务，因此这里只承诺禁用模型可调用的浏览器/搜索能力，不声称隔离 Codex 客户端自身的网络连接。
- 使用 `mktemp -d "${TMPDIR:-/tmp}/vault-query.XXXXXX"` 创建每次调用独占的临时目录，最终回答、stdout 和 stderr 分别写入其中；`trap` 在 `EXIT HUP INT TERM` 时终止子进程并删除临时目录。
- 使用 `--output-last-message <临时文件>`；只有 Codex 退出码为 0 且最终回答文件非空时才把内容写到原脚本的 stdout。
- 超时固定为 300 秒。脚本以后台子进程运行 Codex，并启动 watcher；超时时先发送 `TERM`，5 秒后仍未退出则发送 `KILL`，最终返回退出码 124。
- 非超时失败保留 Codex 的 stderr 并返回其非零退出码；不得输出旧结果、创建空的持久结果或覆盖 vault 中任何文件。
- 执行前后对 vault 做状态/mtime 快照；若发现脚本造成文件变化，则 smoke test 失败并回滚该脚本改动。

`00_Raw` 等不可变目录继续保持只读语义。

### 6.2 xflow

`xflow` 默认执行路径已经是 `codex-login`，因此：

- 保持默认 Agent 不变。
- 保留 Claude、Copilot、Cursor 等可选功能代码，不因当前本机不可用而删除框架能力。
- 只迁移已经失败的 reviewer LLM 本地配置到 Agent-im。

### 6.3 MemOS 与其他扫描命中

MemOS 中的 Claude/OpenCode 命中主要属于框架能力、测试或上游代码；其他项目也存在 README、缓存、历史会话和普通名词命中。这些内容不属于真实的本地执行入口，不做源码替换。

## 7. 确定的项目与文件清单

下表是本轮唯一的实施范围。表中“本地文件”是被 Git 忽略的运行配置；“跟踪文件”是允许产生源码 diff 的文件。未列入表中的项目不得修改。

| 单元 | 已确认运行入口/协议 | 本地文件与变量映射 | 允许修改的跟踪文件 | 决策 |
|---|---|---|---|---|
| agent-im | `/v1/chat/completions`；Codex SDK | 无项目密钥 | `src/platform/app.ts`、`src/lib/bridge/host.ts`、`src/codex-provider.ts`、`ecosystem.config.cjs`、`package.json`、`package-lock.json`、`src/__tests__/openai-chat-completions.test.ts`、`src/__tests__/codex-provider.test.ts` | 补兼容层、Ajv 验证并绑定 loopback |
| DataPlatform | `app/services/task_planner.py`、`app/crawl/llm_extraction.py`；OpenAI Chat Completions | 源码树与部署树的 `.env.distributed.local`：`DP_OPENAI_API_KEY=local-only`、`DP_OPENAI_BASE_URL=http://127.0.0.1:3300/v1`、`DP_LLM_EXTRACTION_MODEL=codex-login/gpt-5.5` | `.env.distributed.example` 只补不含密钥的说明 | 迁移；不改 Ark multimodal/embedding |
| round-table | `lib/llm/client.ts`；OpenAI SDK | `.env`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL_NAME` 映射到 Agent-im | 无 | 迁移；Ark 电影视觉/审阅配置保持不变 |
| looplab | `looplab/engine/solver.py`；OpenAI SDK | 新建已被 `.gitignore` 排除的 `.env`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` | 无 | 迁移可选 LLM solver；heuristic 不变 |
| research_framework | `computational_discovery/llm.py`；OpenAI Chat Completions | `.env`：使用该项目现有优先级最高的 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 指向 Agent-im | 无 | 迁移通用在线生成 profile；多模型 vendor override 不改 |
| xflow reviewer | `server/llm-client.mjs`、`server/task-reviewer.mjs`；OpenAI Chat Completions | `.env`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、`LLM_MODEL` 指向 Agent-im | 无 | 只迁移 LLM reviewer；默认 `codex-login` Agent 与可选 CLI 代码不变 |
| article-writer audit | `article_writer/services/llm.py::chat_audit`；OpenAI SDK | `.env`：`OPENAI_API_KEY=local-only`、`OPENAI_BASE_URL=http://127.0.0.1:3300/v1`、`AUDIT_OPENAI_MODEL=codex-login/gpt-5.5`；清空 `DEEPSEEK_FALLBACK_API_KEY` | `.env.example` 补本地 audit 示例；必要测试只改 `tests/test_llm.py` | 迁移 audit；Volcengine 主模型不改，失效 DeepSeek fallback 禁用 |
| ai_psychology | `run_experiment.py`、`run_multimodel.py` 经 `framework/models.py` | `.env` 新增独立的 `AGENT_IM_API_KEY`、`AGENT_IM_BASE_URL`、`AGENT_IM_MODEL_NAME` | `ai_psychology_research/framework/models.py`、`run_experiment.py`、`run_multimodel.py`、`.env.example`，新增 `tests/test_agent_im_provider.py` | 新增明确显示为 Agent-im Codex 的实验项；不把 Claude/Gemini/DeepSeek 标签改指 Codex |
| hiring-agent | `llm_utils.py` 创建 provider，`models.py` 发请求 | `.env`：`LLM_PROVIDER=agent_im`、`DEFAULT_MODEL=codex-login/gpt-5.5` 及 Agent-im 三个本地变量 | `models.py`、`llm_utils.py`、`prompt.py`、`.env.example`，新增 `tests/test_agent_im_provider.py` | 新增 OpenAI-compatible provider 并让本地环境选择它；不删除旧 provider |
| 五个 Knowledge Vault | 第 6.1 节五个 `query_vault.sh` | 无 | 五个 `query_vault.sh` | Claude CLI 改 Codex CLI；编译 Ark 链路不改 |

明确排除矩阵：

| 项目 | 本轮决策 | 原因 |
|---|---|---|
| MemOS、GEOFlow、`ai_tools`、`go` | 不修改 | 没有确认到必须恢复的失败入口，或已有安全降级；避免框架级泛化改造 |
| `aiacounting`、`qiaomu`、`math-manim`、`zai`、`cloudflare-os` | 不修改 | 公开部署候选，保持生产和本地源码完全原样是最可靠的隔离 |
| `gemini-rate-limit-demo`、`qwen-redteam-suite` | 不修改 | 提供商专用项目，改成 Codex 会破坏项目目的 |
| 仅命中文档、缓存、历史会话、测试夹具的项目 | 不修改 | 不是实际执行入口 |

## 8. Agent-im 兼容层调整

现有 `/v1/chat/completions` 已支持基本文本、流式输出和图片输入。为承接上述本地项目，补足以下最小兼容能力。

### 8.1 `response_format`

请求类型限定为下面三种；其他值返回 HTTP 400 和 `invalid_request_error`。

1. 未提供 `response_format`
   - 保持现有文本、图片和 streaming 行为，不增加 JSON 处理。
2. `{ "type": "json_object" }`
   - 在标准化 prompt 尾部添加“只返回一个合法 JSON value，不含 Markdown”的系统约束。
   - 完整结果用 `JSON.parse` 验证，不做 schema 验证。
3. `{ "type": "json_schema", "json_schema": { "name": "...", "description": "...", "strict": true, "schema": {...} } }`
   - `json_schema`、非空 `name` 和对象类型 `schema` 必填；`description` 可选。
   - `strict` 允许省略、`true` 或 `false`。无论该值如何，Codex 生成都使用 schema 约束；这对 `strict: false` 是允许范围内更严格的结果，不会返回 schema 外字段。
   - 只把 `json_schema.schema` 原样传为 Codex SDK `thread.runStreamed(input, { outputSchema })` 的 `outputSchema`；`name` 和 `description` 只用于请求校验与日志标识。
   - 使用 Ajv 2020 编译 schema；schema 自身非法时在调用模型前返回 HTTP 400。
   - 模型结果先 `JSON.parse`，再用同一 Ajv validator 校验。验证错误只记录字段路径和关键字，不记录完整模型响应。

结构化输出的执行规则：

- 第一次输出解析或 schema 验证失败时，最多做一次修复。修复使用同一模型和同一 schema，开启一个新的临时 API session，将原输出与精简后的验证错误作为修复输入；不复用调用方传入的持久 session。
- 修复后仍失败，返回 HTTP 502，错误类型为 `invalid_response_error`，响应中不包含原始模型正文。
- `stream: false` 在验证通过后返回普通 Chat Completions JSON。
- `stream: true` 且请求结构化输出时，服务端先缓冲、验证和必要的单次修复；成功后才返回 SSE，内容放在一个 assistant delta 中，随后发送 finish/usage chunk 与 `[DONE]`。这样不会把尚未验证的半截 JSON 发给客户端。
- 普通非结构化 `stream: true` 保持现有逐段转发，不受缓冲逻辑影响。

### 8.2 默认执行约束

由 `/v1/chat/completions` 发起的 Codex 线程固定使用：

- `sandboxMode: "read-only"`。
- `networkAccessEnabled: false`。
- `webSearchMode: "disabled"`。
- 调用方显式提供工作目录时，仍受只读沙箱约束。

这些值由 route 层写入 `StreamChatParams`，经 bridge 参数层传给 Codex provider；请求体不提供覆盖字段。测试必须捕获传给 SDK 的 thread options 并断言三项均生效。本次不新增远程管理接口。

### 8.3 接口边界

- Web/API 层负责校验 OpenAI 请求、解析 `response_format` 和返回 OpenAI 风格错误。
- Bridge 参数层负责携带 sandbox、network、web search 和可选 `outputSchema`。
- Codex provider 层只负责把标准化参数传给 Codex SDK：thread options 进入 `startThread/resumeThread`，`outputSchema` 进入 `runStreamed` 的第二参数；不解析项目业务字段。
- 项目适配层只使用标准 OpenAI-compatible 请求，不依赖 Agent-im 内部实现。

## 9. 错误处理与回退规则

### 9.1 健康检查

切换任何本地 `.env` 前以及逐项目 smoke test 前，由实施脚本统一检查 `GET http://127.0.0.1:3300/health`；不为此侵入各项目业务源码。检查失败时：

- 返回清楚的“Agent-im 未启动或不可达”错误。
- 不静默回退到已知失效的 DeepSeek、MiraclePlus、Gemini 或无效 OpenAI key。
- 不改变生产路径的原有回退规则。

### 9.2 重试

- Agent-im 兼容层在尚未向客户端发送任何响应时，只对连接重置、超时、HTTP 429、502、503、504 做一次重试，等待 1 秒；其他状态不重试。
- 认证失败、余额不足、schema 非法和协议错误不重试。
- 一旦普通 streaming 已发送首个 chunk，就不重试，只通过 SSE error/终止事件报告失败，避免重复内容。

### 9.3 结构化输出

- JSON 与 schema 验证、单次修复、stream buffering 和错误响应严格按第 8.1 节执行。
- 瞬时网络重试与结构修复分别计数；一次请求最多发生一次结构修复，不能因为网络重试而重置修复额度。
- 任何无效 JSON 都不得进入成功响应或下游业务。

### 9.4 日志

- 记录项目、模型、状态码、耗时和错误类别。
- 不记录 API key、Authorization header、完整提示词或完整模型响应。
- 本要求只适用于本次新增或修改的日志路径；不扫描、不改写历史日志、缓存或会话文件。

## 10. 验证策略

### 10.1 Agent-im 合同测试

至少覆盖：

1. 健康检查。
2. 普通文本 Chat Completions。
3. 流式 Chat Completions。
4. `json_schema` 结构化输出。
5. `json_schema` 非法 schema、strict 三种取值、schema 验证失败与单次修复上限。
6. `json_object` 输出、非法 JSON 与单次修复上限。
7. 结构化 streaming 在验证前不发送 delta，验证后只发送合法完整 JSON。
8. 图片输入保持兼容。
9. 非法请求、上游失败和超时的错误映射。
10. API 发起的 Codex 线程确实采用只读沙箱、禁用网络与 web search。
11. 服务只监听 `127.0.0.1:3300`，loopback 健康检查成功且 LAN 地址访问失败。

### 10.2 配置测试

- 未设置本地 Agent-im 开关时，生产和已有可用 provider 行为不变。
- 本地 override 的优先级符合项目原有规则。
- Ark 与 NVIDIA 的已验证调用仍然走原上游。
- 第 7 节全部公开部署候选相对实施前基线的文件增量必须为零；其原本已有的未提交修改可以存在，但状态与内容哈希必须保持不变。
- 所有公开部署候选的跟踪文件与构建配置中不得新增 `127.0.0.1:3300` 或其他 loopback/LAN Agent-im 地址；本地项目的 `.env.example`、Agent-im 自身文档和测试可以包含明确标注为 local-only 的 loopback 示例。
- Git diff 中不存在真实 token、key 或凭据。

### 10.3 项目 smoke test

每个被修改项目只运行最小、无业务副作用的 smoke test：

- 配置加载成功。
- 能完成一个最短文本请求，或在 dry-run/mock 下验证路由。
- 结构化输出调用能被正确解析。
- Agent CLI 脚本能读取本地材料并返回回答，但不能修改 vault。

不执行完整文章生产、正式研究批处理、公开部署或其他昂贵工作流。依赖包缺失、数据库不可用等非迁移问题单独记录，不通过扩大本次范围来顺手修复。

### 10.4 启动项与定时任务不变性

本次实现边界只在 M2；不通过 SSH 修改 M4，因此 M4 的启动项和定时任务天然不在写入范围。M2 在第一处代码/配置修改前保存：

- `crontab -l` 的原始文本与 SHA-256。
- `/Users/daniel/Library/LaunchAgents/*.plist` 的文件列表与逐文件 SHA-256。
- `launchctl print gui/$(id -u)/com.agent-im.web` 与 `com.dataplatform.center` 的运行状态快照。

全部实施结束后重新生成同样快照。`crontab` 与所有 plist 必须逐字节一致；允许变化的只有服务 PID、启动时间和运行状态。Agent-im 的 loopback 修改发生在 `ecosystem.config.cjs`，不修改它的 launchd plist。

DataPlatform 只在其源与部署目录的 `.env.distributed.local` 同步完成后，使用 `launchctl kickstart -k "gui/$(id -u)/com.dataplatform.center"` 重启既有服务。重启后 `GET http://127.0.0.1:8100/api/v1/health` 必须返回成功；不得 unload、重建或改写 `com.dataplatform.center.plist`，Cloudflare tunnel 任务不做任何操作。

## 11. 实施顺序

1. 保存第 7 节所有目标工作树以及第 10.4 节启动项/定时任务基线；确认公开部署候选不在写入范围。
2. 在 `agent-im` 增加 loopback 绑定、`response_format`、只读 sandbox 与无网络默认值，并补齐测试。
3. 验证 Agent-im 的监听地址、文本、流式、JSON schema、图片和错误路径。
4. 改造五个 Knowledge Vault 查询脚本，从 Claude CLI 切换到 Codex CLI。
5. 按第 7 节迁移只需本地环境配置的项目：DataPlatform、round-table、looplab、research_framework、xflow reviewer、article-writer audit。
6. 按第 7 节处理需要轻量 provider 适配的 `ai_psychology` 与 `hiring-agent`。
7. 逐项目执行 smoke test、安全扫描与 diff 审查；确认排除矩阵的项目没有变化。
8. 对比启动项/定时任务快照，输出成功项和剩余阻塞项。

DataPlatform 的部署与重启严格按第 10.4 节执行，不同步无关源码，不改动既有 launchd 启动与定时任务定义。

## 12. 回滚

- Agent-im 的兼容层修改可通过单独 Git commit 回退。
- 项目配置优先采用独立本地 override；移除 override 即恢复原默认行为。
- CLI 脚本保留清晰、单一的迁移 commit，必要时可恢复原 `claude --print` 调用。
- 不删除旧 provider 的框架支持，只停止在 M2 本地默认选择已失败的 provider。
- 不覆盖用户工作树；若目标文件已有重叠修改，实施时先暂停该项目并报告冲突。

## 13. 完成标准

本次迁移完成需同时满足：

- 第 6.1 节五个真实 Claude CLI 查询入口全部改为 Codex，且 vault 内容在 smoke test 前后不变。
- 第 7 节纳入范围的每个本地项目/单元均有明确的成功 smoke test，或有不扩大范围的具体阻塞记录。
- 原先可用的 Ark、NVIDIA、Codex、Cursor 调用没有被替换或破坏。
- 公开部署候选相对实施前基线没有任何文件变化，生产配置和源码没有新增本机接口引用。
- Provider 专用演示项目未被修改。
- 没有新的密钥进入 Git，日志不泄漏提示词、响应正文或凭据。
- Agent-im 只监听 loopback，结构化输出契约和安全 thread options 通过合同测试。
- 每个修改项目都有验证结果；无法运行的项目列出具体阻塞原因。
- M2 的 crontab 与全部 LaunchAgent plist 在实施前后逐字节一致；M4 不发生任何写入。

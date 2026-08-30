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
- 不批量重写 MemOS、GEOFlow、`ai_tools` 等多提供商框架的源码；仅在其已支持的配置面增加或选择本地 profile。
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

`agent-im` 继续只作为本机可信开发接口使用。当前服务监听 `*:3300` 且没有 API 鉴权，因此本次不会把该端口暴露到公网，也不会将其写进任何公开部署配置。

## 5. 本地配置契约

通用本地配置使用下列语义：

```dotenv
LLM_PROVIDER=agent-im
AGENT_IM_BASE_URL=http://127.0.0.1:3300/v1
AGENT_IM_MODEL=codex-login/gpt-5.5
AGENT_IM_API_KEY=local-only
```

实施时优先映射到项目已有的变量名，例如 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`MODEL_NAME` 或项目自己的 provider 配置项，避免为了统一变量名而改动大量源码。

约束如下：

- `AGENT_IM_API_KEY` 只是满足部分 OpenAI SDK 的非空参数校验；本机 Agent-im 当前不依赖它鉴权。
- `.env.example` 可以记录占位值和说明；真实 `.env` 必须保持未跟踪。
- 本地覆盖文件应具有高于默认配置、低于显式命令行参数的优先级。
- 生产构建和部署环境未显式设置 `LLM_PROVIDER=agent-im` 时，必须继续走原生产路径。

## 6. Agent CLI 迁移

### 6.1 Knowledge Vault 查询脚本

以下五个脚本存在真实的 `claude --print` 执行路径：

- `/Users/daniel/Documents/KnowledgeVaults/kaggle/99_Scripts/query_vault.sh`
- `/Users/daniel/Documents/KnowledgeVaults/startups/99_Scripts/query_vault.sh`
- `/Users/daniel/Documents/KnowledgeVaults/substack/99_Scripts/query_vault.sh`
- `/Users/daniel/Documents/KnowledgeVaults/wechat/99_Scripts/query_vault.sh`
- `/Users/daniel/Documents/Obsidian Vault/99_Scripts/query_vault.sh`

这些调用改为等价的 `codex exec`：

- 工作目录固定为对应 vault 根目录。
- 使用 `--sandbox read-only`，禁止修改知识库。
- 使用 `--ephemeral`，不保留会话状态。
- 使用 `--skip-git-repo-check`，兼容非 Git vault。
- 使用 `--output-last-message` 将最终回答写入临时文件，再由原脚本读取或输出。
- 使用固定超时；失败时返回非零状态，不创建空结果或覆盖既有结果。
- 不启用网络访问，查询只使用本地知识库内容。

`00_Raw` 等不可变目录继续保持只读语义。

### 6.2 xflow

`xflow` 默认执行路径已经是 `codex-login`，因此：

- 保持默认 Agent 不变。
- 保留 Claude、Copilot、Cursor 等可选功能代码，不因当前本机不可用而删除框架能力。
- 只迁移已经失败的 reviewer LLM 本地配置到 Agent-im。

### 6.3 MemOS 与其他扫描命中

MemOS 中的 Claude/OpenCode 命中主要属于框架能力、测试或上游代码；其他项目也存在 README、缓存、历史会话和普通名词命中。这些内容不属于真实的本地执行入口，不做源码替换。

## 7. LLM API 迁移矩阵

| 项目/类别 | 当前判断 | 目标动作 | 生产影响 |
|---|---|---|---|
| DataPlatform | OpenAI-compatible 配置，但 URL/协议错配导致 404 | 本地后端配置指向 Agent-im；保留原 provider 配置模板 | 无；仅 M2 本地服务 |
| round-table | 当前上游 401 | 复用现有 OpenAI-compatible 配置，增加本地 Agent-im override | 无；本地运行 |
| looplab | 官方 OpenAI key 401 | 本地环境指向 Agent-im | 无；本地运行 |
| research_framework | 在线代理失败，离线流程可用 | 仅把需要在线文本生成的本地 profile 指向 Agent-im | 无；研究源码不伪装多模型 |
| xflow reviewer | reviewer 上游失败 | reviewer 本地配置指向 Agent-im；默认 Codex Agent 不变 | 无 |
| go | 存在失效文本生成配置，且工作树已有用户修改 | 只在确认真实执行入口后添加本地 Agent-im override | 无；不碰无关改动 |
| article-writer | Ark 主模型可用；审计 MiraclePlus、fallback DeepSeek 失败 | 保留 Ark 主模型；审计迁到 Agent-im；选择 Agent-im 时禁用坏 fallback | 无 |
| ai_psychology | 多个在线 provider 不可用 | 增加明确名为 `agent-im-codex` 的 provider；实验需显式选择 | 无；不冒充其他模型 |
| hiring-agent | Claude 设置实际落到失效 DeepSeek | 增加 OpenAI-compatible Agent-im provider，并让本地默认选择它 | 无 |
| 五个 Knowledge Vault | 编译可用 Ark；查询依赖失效 Claude CLI | 编译链路不改；查询 CLI 改为 Codex | 无 |
| MemOS | 多提供商框架，含本地明文密钥风险 | 只配置本地 provider/profile；不重写框架 | 无 |
| GEOFlow | 多提供商或项目级配置 | 仅在已有配置能力范围内选择 Agent-im | 无 |
| ai_tools | Ark key 格式错误 | 先保留框架，提供本地 Agent-im profile；不把错误 key 写入提交 | 无 |
| aiacounting、qiaomu | 公开部署候选，已有 OpenAI 客户端 | 仅本地开发环境可选择 Agent-im；生产变量不改 | 生产不变 |
| math-manim、zai | 公开部署候选，偏 Anthropic 客户端 | 如确有本地需求，增加显式 opt-in 的 Agent-im 分支；默认生产路径不改 | 生产不变 |
| cloudflare-os | Cloudflare 公开部署项目 | 不将 localhost 写入 Worker/Pages 配置；仅允许独立本地开发覆盖 | 生产不变 |

每个项目在实施前必须确认实际调用点、配置优先级和工作树状态。仅有字符串命中但没有执行路径的项目不修改。

## 8. Agent-im 兼容层调整

现有 `/v1/chat/completions` 已支持基本文本、流式输出和图片输入。为承接上述本地项目，补足以下最小兼容能力。

### 8.1 `response_format`

支持 OpenAI Chat Completions 常见的两类结构化输出请求：

1. `type: "json_schema"`
   - 读取调用方提供的 schema。
   - 转换为 Codex SDK `outputSchema`，传入 `thread.runStreamed`。
   - schema 缺失或非法时返回明确的 HTTP 400，不静默降级成普通文本。
2. `type: "json_object"`
   - 在不改变业务提示词主体的前提下附加严格 JSON 输出要求。
   - 返回后进行 JSON 解析验证。

未提供 `response_format` 时保持现有行为，避免影响已经能用的调用方。

### 8.2 默认执行约束

由 API 发起的 Codex 线程默认使用：

- 只读沙箱。
- 禁止网络访问。
- 不开放 shell 写入能力。
- 调用方显式提供工作目录时，仍受只读沙箱约束。

本次不新增远程管理接口，也不允许项目通过 Chat Completions 请求覆盖这些安全默认值。

### 8.3 接口边界

- Web/API 层负责校验 OpenAI 请求、解析 `response_format` 和返回 OpenAI 风格错误。
- Bridge 参数层负责携带 sandbox、network 和 output schema 等运行选项。
- Codex provider 层只负责把标准化参数传给 Codex SDK，不解析项目业务字段。
- 项目适配层只使用标准 OpenAI-compatible 请求，不依赖 Agent-im 内部实现。

## 9. 错误处理与回退规则

### 9.1 健康检查

选择 Agent-im 的本地项目在发出较重请求前，应检查本机端点是否可达。检查失败时：

- 返回清楚的“Agent-im 未启动或不可达”错误。
- 不静默回退到已知失效的 DeepSeek、MiraclePlus、Gemini 或无效 OpenAI key。
- 不改变生产路径的原有回退规则。

### 9.2 重试

- 只对连接重置、超时、HTTP 429 和部分 5xx 等瞬时错误做有限重试。
- 认证失败、余额不足、schema 非法和协议错误不重试。
- 重试次数和退避保持小规模，避免定时任务重复产生高成本调用。

### 9.3 结构化输出

- 请求 JSON 时必须先解析验证。
- 验证失败最多允许一次明确的 JSON 修复请求。
- 第二次仍失败则返回错误，不把无效 JSON 传给下游业务。

### 9.4 日志

- 记录项目、模型、状态码、耗时和错误类别。
- 不记录 API key、Authorization header、完整提示词或完整模型响应。
- 必须对现有日志中可能出现的凭据做掩码处理。

## 10. 验证策略

### 10.1 Agent-im 合同测试

至少覆盖：

1. 健康检查。
2. 普通文本 Chat Completions。
3. 流式 Chat Completions。
4. `json_schema` 结构化输出。
5. `json_object` 输出和非法 JSON 处理。
6. 图片输入保持兼容。
7. 非法请求、上游失败和超时的错误映射。
8. API 发起的 Codex 线程确实采用只读沙箱且默认无网络。

### 10.2 配置测试

- 未设置本地 Agent-im 开关时，生产和已有可用 provider 行为不变。
- 本地 override 的优先级符合项目原有规则。
- Ark 与 NVIDIA 的已验证调用仍然走原上游。
- 公开部署配置中不存在 `127.0.0.1:3300`。
- Git diff 中不存在真实 token、key 或凭据。

### 10.3 项目 smoke test

每个被修改项目只运行最小、无业务副作用的 smoke test：

- 配置加载成功。
- 能完成一个最短文本请求，或在 dry-run/mock 下验证路由。
- 结构化输出调用能被正确解析。
- Agent CLI 脚本能读取本地材料并返回回答，但不能修改 vault。

不执行完整文章生产、正式研究批处理、公开部署或其他昂贵工作流。依赖包缺失、数据库不可用等非迁移问题单独记录，不通过扩大本次范围来顺手修复。

## 11. 实施顺序

1. 在 `agent-im` 增加 `response_format`、只读 sandbox 与无网络默认值，并补齐测试。
2. 验证 Agent-im 的文本、流式、JSON schema、图片和错误路径。
3. 改造五个 Knowledge Vault 查询脚本，从 Claude CLI 切换到 Codex CLI。
4. 迁移配置简单、已有 OpenAI-compatible 客户端的本地项目：DataPlatform、round-table、looplab、research_framework、xflow reviewer、`go`。
5. 处理需要轻量 provider 适配的项目：article-writer、ai_psychology、hiring-agent。
6. 只为 MemOS、GEOFlow、`ai_tools` 提供或选择本地 profile。
7. 对公开部署候选仅增加本地 opt-in，核对生产配置零变化。
8. 逐项目执行 smoke test、安全扫描与 diff 审查，输出成功项和剩余阻塞项。

DataPlatform 若需要使当前本地服务加载新配置，先修改其源码/本地配置，再只部署必要文件并重启本地后端。不得改动既有 launchd 启动与定时任务定义。

## 12. 回滚

- Agent-im 的兼容层修改可通过单独 Git commit 回退。
- 项目配置优先采用独立本地 override；移除 override 即恢复原默认行为。
- CLI 脚本保留清晰、单一的迁移 commit，必要时可恢复原 `claude --print` 调用。
- 不删除旧 provider 的框架支持，只停止在 M2 本地默认选择已失败的 provider。
- 不覆盖用户工作树；若目标文件已有重叠修改，实施时先暂停该项目并报告冲突。

## 13. 完成标准

本次迁移完成需同时满足：

- 所有被确认失效且在真实执行路径中的 Agent CLI 已改为可用 Codex，或被明确保留为非默认可选能力。
- 目标本地文本生成项目能够通过 Agent-im/Codex 完成最小请求。
- 原先可用的 Ark、NVIDIA、Codex、Cursor 调用没有被替换或破坏。
- 公开部署和 iOS/Cloudflare/Vercel 生产配置没有指向本机接口。
- Provider 专用演示项目未被修改。
- 没有新的密钥进入 Git，日志不泄漏提示词、响应正文或凭据。
- 每个修改项目都有验证结果；无法运行的项目列出具体阻塞原因。
- 两台机器现有开机启动和定时任务没有被破坏。


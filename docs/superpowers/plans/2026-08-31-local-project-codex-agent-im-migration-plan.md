# M2 本地项目 Codex / Agent-im 迁移实施计划

- 日期：2026-08-31
- 状态：待实施确认
- 依据：[M2 本地项目 Agent 与 LLM 调用迁移设计](../specs/2026-08-31-local-project-codex-agent-im-migration-design.md)
- 实施主机：M2
- 不写入主机：M4（`caoxiaopeng@192.168.1.127`）

本计划以“能通不改、本地优先、生产隔离”为验收主线。实施只触及设计文档第 7 节的白名单文件，不运行完整业务流水线，不部署公开应用，不修改任何 crontab 或 LaunchAgent plist，也不推送远程仓库。

1. 建立可审计的实施基线与私密回滚副本。

   - 在 `/Users/daniel/Documents/Codex/2026-08-12/d/outputs/agent-im-migration-20260831/` 保存不含密钥的基线报告：时间、Git 分支、`git status --short`、目标文件哈希、公开部署排除项哈希、运行服务状态。
   - 保存 `crontab -l` 原文及 SHA-256、`/Users/daniel/Library/LaunchAgents/*.plist` 文件列表与逐文件 SHA-256、`/Users/daniel/.codex/config.toml` SHA-256。
   - 保存 `launchctl print gui/$(id -u)/com.agent-im.web`、`com.dataplatform.center` 和 `pm2 describe agent-im` 的只读状态快照。
   - 使用 `umask 077` 创建独立、非 Git 的私密备份目录，备份本轮将改动的 `.env` 文件；报告中只记录备份路径和哈希，不记录内容。
   - 对已知脏工作树逐项记录基线。任何目标文件若包含未识别的用户修改，先停止该项目，不覆盖、不 stash、不 reset。
   - 验证：基线报告不包含形如 API key/token 的值；所有备份权限仅当前用户可读。

2. 先为 Agent-im 的 OpenAI 兼容契约补失败测试。

   - 目标文件：
     - `/Users/daniel/service/agent-im/src/__tests__/openai-chat-completions.test.ts`
     - `/Users/daniel/service/agent-im/src/__tests__/codex-provider.test.ts`
   - 添加请求校验测试：未知 `response_format`、缺少 `json_schema.name/schema`、非法 schema 返回 HTTP 400。
   - 添加 `json_object` 测试：合法对象成功；数组、字符串、数值、布尔值、`null` 与非法 JSON 触发一次修复；第二次失败返回 HTTP 502 `invalid_response_error`。
   - 添加 `json_schema` 测试：`strict` 省略/true/false、`additionalProperties` 服从调用方 schema、Ajv 编译错误、验证失败与单次修复上限。
   - 添加结构化 streaming 测试：验证完成前无 SSE delta；成功后只发送完整合法 JSON、finish/usage 和 `[DONE]`。
   - 添加 Codex SDK 参数测试：route 固定传入 `sandboxMode=read-only`、`networkAccessEnabled=false`、`webSearchMode=disabled`，并把 schema 放在 `runStreamed` 第二参数的 `outputSchema`。
   - 运行目标测试，确认新测试在实现前以预期原因失败；原有普通文本、普通 streaming 和图片测试仍保持原状态。

3. 实现 Agent-im 的结构化输出与安全线程参数。

   - 目标文件：
     - `/Users/daniel/service/agent-im/src/platform/app.ts`
     - `/Users/daniel/service/agent-im/src/lib/bridge/host.ts`
     - `/Users/daniel/service/agent-im/src/codex-provider.ts`
     - `/Users/daniel/service/agent-im/package.json`
     - `/Users/daniel/service/agent-im/package-lock.json`
   - 用包管理器安装 Ajv，并让 lockfile 只产生该依赖所需变化。
   - 在 API 层增加 `response_format` 类型、校验和标准化函数；错误响应不包含 prompt、模型正文或凭据。
   - `json_object` 只接受非 null、非数组的对象；`json_schema` 把调用方 `schema` 原样传给 Codex SDK，并用同一 Ajv validator 验收。
   - 增加统一的结构化结果收集、一次修复和 buffered SSE 响应路径；普通 streaming 继续使用现有路径。
   - 在 `StreamChatParams` 增加可选 `outputSchema`，由 Codex provider 传到 `thread.runStreamed(input, { outputSchema })`。
   - `/v1/chat/completions` 固定注入只读 sandbox、禁用网络和禁用 web search；请求体不能覆盖。
   - 只在首个响应尚未发送时，对连接重置、超时、429/502/503/504 做一次 1 秒后重试；不对认证、schema 或协议错误重试。
   - 验证：运行目标测试、`npm run typecheck`，随后运行 Agent-im 全量测试；若全量测试存在实施前已知失败，必须区分基线失败与新增回归。

4. 将 Agent-im Web/API 收紧为 loopback 监听并验证启动链路。

   - 目标文件：`/Users/daniel/service/agent-im/ecosystem.config.cjs`。
   - 让 PM2 的 `npm start` 显式传入 Next.js `-H 127.0.0.1`；不修改 `/Users/daniel/Library/LaunchAgents/com.agent-im.web.plist`。
   - 运行 Agent-im 现有构建与 PM2 重启流程；不新增第二个进程，不改变端口 3300。
   - 验证：
     - `lsof` 只显示 `127.0.0.1:3300`。
     - loopback `/health` 成功。
     - M2 局域网 IP 的 3300 访问失败。
     - 普通文本、普通 streaming、`json_object`、`json_schema` 和图片合同 smoke test 均成功。
     - `com.agent-im.web.plist` 哈希与基线一致。
   - 停止条件：监听仍为 `*`、健康检查失败或旧 Web/API 功能回归时，不继续迁移任何项目配置。

5. 将五个 Knowledge Vault 的真实 Claude CLI 查询入口迁移到 Codex CLI。

   - 目标文件：
     - `/Users/daniel/Documents/KnowledgeVaults/kaggle/99_Scripts/query_vault.sh`
     - `/Users/daniel/Documents/KnowledgeVaults/startups/99_Scripts/query_vault.sh`
     - `/Users/daniel/Documents/KnowledgeVaults/substack/99_Scripts/query_vault.sh`
     - `/Users/daniel/Documents/KnowledgeVaults/wechat/99_Scripts/query_vault.sh`
     - `/Users/daniel/Documents/Obsidian Vault/99_Scripts/query_vault.sh`
   - 保留每个脚本原有参数、知识检索、输出格式和错误码，只替换实际 `claude --print` 执行段。
   - prompt 经 stdin 传入 `codex exec -`；固定使用只读沙箱、临时会话、vault cwd、跳过 Git 检查、无颜色和 `--output-last-message`。
   - 在同一次 invocation 上使用设计批准的九个 `--disable` 参数，不修改全局 Codex 配置。
   - 使用权限为 700 的临时目录、stdout/stderr/最终回答分离、`EXIT/HUP/INT/TERM` trap、300 秒 watchdog、TERM 后 5 秒 KILL，超时返回 124。
   - 先用 PATH 中的临时 Codex stub 验证 prompt、选项、成功、空输出、非零退出、超时和清理行为，再对每个 vault 各做一次最小真实查询。
   - 验证：五个 vault 在真实查询前后的文件内容/mtime 快照一致；`00_Raw` 无变化；`/Users/daniel/.codex/config.toml` 哈希与基线一致。

6. 迁移 DataPlatform 本地文本生成配置并重启既有后端。

   - 本地配置文件：
     - `/Users/daniel/Desktop/crawl/dataplatform/.env.distributed.local`
     - `/Users/daniel/.dataplatform-center/app/.env.distributed.local`
   - 跟踪文件：`/Users/daniel/Desktop/crawl/dataplatform/.env.distributed.example`。
   - 只设置 `DP_OPENAI_API_KEY=local-only`、`DP_OPENAI_BASE_URL=http://127.0.0.1:3300/v1`、`DP_LLM_EXTRACTION_MODEL=codex-login/gpt-5.5`；保持数据库、分布式节点、Cloudflare tunnel、multimodal Ark 和 embedding 配置不变。
   - 在 example 文件增加 local-only 注释和占位示例，不写真实密钥。
   - 分别从源码树和部署树加载 Settings，断言两边解析出的三个值一致且没有输出 key。
   - 使用 `launchctl kickstart -k "gui/$(id -u)/com.dataplatform.center"` 重启既有服务；不 unload、不重建 plist，不操作 Cloudflare tunnel。
   - 验证：`GET http://127.0.0.1:8100/api/v1/health` 成功；用无持久副作用的最小 planner/LLM smoke request 验证 `json_object`；DataPlatform 的数据库和启动项配置哈希不变。

7. 迁移四个已有 OpenAI-compatible 客户端的本地配置。

   - `/Users/daniel/Desktop/git/round-table/.env`：只改 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL_NAME`；Ark 电影视觉/审阅变量不变。
   - `/Users/daniel/Desktop/looplab/.env`：创建已被 `.gitignore` 排除的本地文件，设置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`；heuristic 与 Semantic Scholar 配置不变。
   - `/Users/daniel/Desktop/research_framework/.env`：清空旧代理使用的 `ANTHROPIC_*` 三项，设置 `OPENAI_*` 三项；ERA、evolve、flash、evaluation 等 vendor-specific override 不变。
   - `/Users/daniel/Desktop/xflow/.env`：只改 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、`LLM_MODEL`；Telegram、数据库、Codex/Cursor/Claude/Copilot 可选 Agent 代码和默认 `codex-login` 不变。
   - 每改一个项目先检查 Agent-im `/health`，再运行配置加载和一条最短文本请求；失败立即恢复该项目私密备份，不影响已成功项目。
   - 验证：`.env` 均仍被 Git 忽略；四个工作树的跟踪文件相对基线无新增变化；模型字段明确为 `codex-login/gpt-5.5`。

8. 迁移 article-writer 的审计模型，保留可用 Ark 主模型。

   - 本地文件：`/Users/daniel/Desktop/article-writer/.env`。
   - 跟踪文件：
     - `/Users/daniel/Desktop/article-writer/.env.example`
     - `/Users/daniel/Desktop/article-writer/tests/test_llm.py`
   - 审计配置改为 Agent-im：`OPENAI_API_KEY=local-only`、`OPENAI_BASE_URL=http://127.0.0.1:3300/v1`、`AUDIT_OPENAI_MODEL=codex-login/gpt-5.5`。
   - 清空 `DEEPSEEK_FALLBACK_API_KEY`，从而使用现有代码明确禁用余额不足的 fallback；不改 `VOLCENGINE_*`、Chrome MCP、WebGemini 或 Telegram 配置。
   - 在 `.env.example` 增加 local-only audit 示例和“不要提交真实密钥”说明；在 `tests/test_llm.py` 固化 audit 指向 Agent-im 时不启用 DeepSeek fallback、Ark 主配置不变的断言。
   - 验证：现有与新增单元测试通过；Ark 主客户端仍解析原 endpoint/model；`chat_audit` 的最小结构化请求通过 Agent-im；不运行完整文章生成流水线。

9. 为 ai_psychology 增加语义明确的 Agent-im Codex 实验项。

   - 目标根目录：`/Users/daniel/Desktop/ai_psychology/ai_psychology_research`。
   - 目标文件：`framework/models.py`、`run_experiment.py`、`run_multimodel.py`、`.env.example`，新增 `tests/test_agent_im_provider.py`；本地 `.env` 仅增加 `AGENT_IM_*` 三项。
   - 增加独立 provider 标识 `agent-im-codex`，内部复用 OpenAI-compatible 客户端，但实验输出、表格和日志明确显示 Agent-im/Codex。
   - `run_experiment.py` 与 `run_multimodel.py` 增加显式可选模型项；不把 Claude、Gemini、DeepSeek、DashScope 或 Doubao 的名字、配置和结果标签改指 Codex。
   - 测试 provider 选择、base URL/model 解析、请求格式和结果标签；使用 mock 验证不需要真实 key。
   - 最后只运行一次 Agent-im 模型的最小真实调用，不执行完整心理学多模型实验。

10. 为 hiring-agent 增加本地 Agent-im provider，并保留现有 provider。

   - 目标根目录：`/Users/daniel/Desktop/moshi-gemini/hiring-agent`。
   - 目标文件：`models.py`、`llm_utils.py`、`prompt.py`、`.env.example`，新增 `tests/test_agent_im_provider.py`；本地 `.env` 设置 `LLM_PROVIDER=agent_im` 和 Agent-im/model 变量。
   - 先核对这些文件已有未提交修改，逐块合并，不覆盖用户的 `llm_utils.py`、`models.py`、`prompt.py` 与 `.env.example` 现有差异。
   - 在 `ModelProvider` 中新增 `AGENT_IM`，实现 OpenAI Chat Completions 请求和现有 `LLMProvider` 返回结构；`format` 参数映射为 `json_schema` 或项目所需的 JSON object 约束。
   - 在 provider 工厂与模型映射中支持 `agent_im`，本地 `.env` 选择它；Ollama、Gemini 和 ClaudeSettingsProvider 代码继续保留。
   - 测试 provider 工厂、请求头不泄漏、结构化请求、响应解析、超时和错误；再做一次最短真实请求，不运行批量简历评分。

11. 执行跨项目回归、安全扫描和排除项对比。

   - 对 Agent-im、DataPlatform、article-writer、ai_psychology、hiring-agent 运行各自相关测试；对配置-only 项目运行最小 import/config/client smoke test。
   - 重新验证当前可用能力：Codex CLI、Cursor Agent、Volcengine Ark、NVIDIA API；只做轻量探测，不改变其配置。
   - 扫描所有新增 diff：真实 API key/token、Authorization 值、`.env` 被跟踪、完整 prompt/response 日志、公开部署文件中的 Agent-im loopback/LAN 地址。
   - 对 MemOS、GEOFlow、`ai_tools`、`go`、公开部署候选、Gemini/Qwen 专用项目重算基线哈希；要求相对实施前无文件变化。
   - 检查每个仓库 `git diff --check` 和 `git status --short`，将用户原有变化与本轮变化分栏记录。
   - 不自动提交或推送项目源码；完成后由用户决定各仓库的提交策略。

12. 对比自动化基线、完成回滚演练并生成交付报告。

   - 重新采集 `crontab -l`、全部 LaunchAgent plist、`~/.codex/config.toml` 和公开部署排除项哈希。
   - 要求 crontab、plist、Codex 全局配置逐字节一致；M4 不发生任何写入或服务重启。
   - 确认 Agent-im 和 DataPlatform 重启后仍由原 launchd/PM2 链路管理，未新增重复服务。
   - 对一个配置-only 项目验证“恢复私密备份即可回滚”，对源码项目验证 Git diff 可独立撤销；演练只使用临时副本，不撤销最终成果。
   - 在 `/Users/daniel/Documents/Codex/2026-08-12/d/outputs/agent-im-migration-20260831/` 生成最终报告：成功项、失败/阻塞原因、测试结果、服务状态、监听地址、未提交变更、回滚位置和建议提交拆分。
   - 私密 `.env` 备份默认保留到用户确认运行稳定；报告中提醒其位置和删除时机，但本轮不自动删除。

## Open Questions

无。项目范围、安全边界、公开部署处理、provider 语义和自动化不变性均已在批准的设计中确定。实施中若发现目标文件存在重叠用户修改或原配置已经恢复，将按“能通不改”原则停止该项目并报告，而不自行扩大范围。

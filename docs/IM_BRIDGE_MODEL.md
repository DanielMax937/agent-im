# IM bridge model (概念与边界)

本仓库里有两条**不要混在一起来想**的线：

| 线 | 做什么 | 代码大致位置 |
|----|--------|----------------|
| **IM bridge** | Telegram / Discord / Feishu / QQ / Agent 通道 ↔ 本地 LLM（Claude / Codex / Cursor） | `src/lib/bridge/`, `src/main.ts`, `src/store.ts` |
| **Platform / Jira agent** | 项目 / Sprint / 任务会话、Jira 轮询、`InstanceManager` | `src/platform/` |

本文只约定 **IM bridge** 的概念；Jira 侧见 [PLATFORM_AGENT_JIRA.md](./PLATFORM_AGENT_JIRA.md)。

**同一进程内多个 IM bot（含同平台多 Token）** 的配置与 store 键约定见 [IM_BRIDGE_MULTI_INSTANCE.md](./IM_BRIDGE_MULTI_INSTANCE.md)。

---

## 术语

- **Bot 实例**  
  一个 IM 上的机器人身份（例如一个 Telegram Bot Token）。**同一进程、同一 `CTI_HOME` 下**可通过 `CTI_IM_INSTANCES` 注册多个实例（见 [IM_BRIDGE_MULTI_INSTANCE.md](./IM_BRIDGE_MULTI_INSTANCE.md)）；也可用 **两个 `CTI_HOME` + 两个 bridge 进程**各跑一套凭证。

- **Channel binding（通道绑定）**  
  把某个 `channelType + chatId` 绑到本地 `codepilotSessionId`（会话）。**一个 Bot 下可以有多个 chat，每个 chat 一条 binding**。

- **Runner / runtime profile**  
  配置里的 **Runtime profile**（`config.runtimeProfiles[]`，见 `config.env` 中 `CTI_RUNTIME_PROFILES`）。每个 profile 指定一种后端：`claude` | `codex` | `cursor` | `auto`。

- **同一 Bot 下的「多实例」**（IM 语义）  
  指 **多个 binding / 多个 chat**，每个 binding 可带 **`runnerProfileId`**，在对话时走 **不同的 LLM 实例**（`buildImBridgeLlmStack` 按 profile 各建一个 `LLMProvider`）。  
  这与 **Agent 通道**里 `CTI_AGENT_1_*`（Redis + OpenAI 的另一套栈）不是同一概念。

---

## 行为（当前实现）

1. 启动时按 **runtime profiles** 建 **多个** `LLMProvider`（共享 `PendingPermissions`）。
2. 处理某条消息时，`conversation-engine` 使用  
   `resolveLlmForBinding(binding)`：  
   - 若 `binding.runnerProfileId` 有值 → 用对应 profile；  
   - 否则用 `bridge_default_runner_profile_id`（来自配置的 default profile）或第一个 profile。
3. **新建** chat 的默认 `runnerProfileId` 来自 store 设置 `bridge_default_runner_profile_id`（由 `configToSettings` 从 `defaultRuntimeProfileId` 写入）。  
4. 已有 binding 可通过 `updateChannelBinding` 更新 `runnerProfileId`（或改 `bindings.json` 后重启）。
5. **IM 命令**：在聊天中发送 **`/runner`** 列出当前 chat 的生效 profile 与全部可选 profile；**`/runner &lt;profile_id&gt;`** 切换本 chat 的 runner；**`/runner default`**（或 `reset`）清除本 chat 的覆盖，回到服务端默认。别名 **`/runners`** 与无参数的 **`/runner`** 相同。Discord 可用 **`!runner`**（与 `!` → `/` 的约定一致）。

---

## 多 Bot、多机器

- **同一机器、两个 Bot、两套凭证**：可用 **两个 `CTI_HOME` + 两个 bridge 进程**（两套 `config.env`），或 **单进程 + `CTI_IM_INSTANCES`** 多实例（见 [IM_BRIDGE_MULTI_INSTANCE.md](./IM_BRIDGE_MULTI_INSTANCE.md)）。  
- **同一 `CTI_HOME`、单进程内多 Telegram Bot Token**：由 `CTI_IM_INSTANCES` 与适配器多实例注册实现；未配置多实例时仍使用旧版单 Token 字段。

---

## 与 Jira agent 的关系

- **不要**把「Jira 上的 developer/reviewer 实例」和「IM 里某个 chat 的 binding」当成同一种「实例」。  
- 平台任务走 `JsonPlatformStore` + `InstanceManager`；IM 走 `BridgeStore` + `ChannelBinding`。二者只在「都叫 agent」这个字面上相似，**数据与进程模型分开**。

# IM bridge：通用多实例（Multi-instance）

本文约定：**同一 bridge 进程**内如何挂**多个 IM 机器人（bot）**，并与 [IM_BRIDGE_MODEL.md](./IM_BRIDGE_MODEL.md) 中的 **profile / binding** 概念配合。

---

## 目标

1. **统一抽象**：「跨平台多个 bot」与「同平台多个 bot」用**同一套**配置模型——**多个连接实例（instance）**，每个实例有 `channel` + `id` + 凭证。
2. **路由**：每个实例的 `channelType` 为 `"{base}:{id}"`（`id === "default"` 时为裸 `telegram` / `discord` 等，兼容旧数据）。
3. **兼容**：未配置 `CTI_IM_INSTANCES` 时，行为与旧版一致（单 Telegram Token、单 Discord Token 等）。

---

## 配置：`CTI_IM_INSTANCES`

在 `~/.claude-to-im/config.env` 中增加可选 JSON 数组（单行或换行转义由 `saveConfig` 写入）：

```env
CTI_IM_INSTANCES=[{"id":"work","channel":"telegram","enabled":true,"tgBotToken":"123:ABC","tgAllowedUsers":["111"]},{"id":"fun","channel":"discord","discordBotToken":"..."}]
```

### 字段（`ImInstanceSpec`）

| 字段 | 说明 |
|------|------|
| `id` | 实例 slug：`[a-zA-Z0-9_-]+`，在同一 `channel` 下唯一。 |
| `channel` | `telegram` \| `discord` \| `feishu` \| `qq` |
| `enabled` | 可选，默认 `true`。 |
| **Telegram** | `tgBotToken`, `tgAllowedUsers`, `tgChatId` |
| **Discord** | `discordBotToken`, `discordAllowedUsers`, `discordAllowedChannels`, `discordAllowedGuilds` |
| **飞书** | `feishuAppId`, `feishuAppSecret`, `feishuDomain`, `feishuAllowedUsers` |
| **QQ** | `qqAppId`, `qqAppSecret`, `qqAllowedUsers`, `qqImageEnabled`, `qqMaxImageSize` |

当某个 `channel` **至少有一条**出现在 `CTI_IM_INSTANCES` 中时，该通道的**旧版单凭证字段**不再用于该通道的多实例列表（仍可为其它未声明的通道保留旧字段）。

---

## Store 键（内部）

Bridge 将每个实例映射为带前缀的 `JsonFileStore` 设置键，供适配器读取：

- **通用规则**：`bridge_{channel}_{instanceId}_{...}`，例如 `bridge_telegram_work_enabled`。
- **Telegram 特例**：`telegram_{instanceId}_bot_token`（由 `telegram_bot_token` 派生），以及 `telegram_{instanceId}_bridge_allowed_users` 等。

`id === "default"` 时仍使用**无实例后缀**的 legacy 键（`telegram_bot_token`、`bridge_telegram_enabled` 等）。

发现列表：`bridge_{channel}_instances` = 逗号分隔的 id 列表（由 `configToSettings` 从 `CTI_IM_INSTANCES` 生成）。

---

## 与 profile / binding 的关系

- **Runtime profile**（runner）：仍是**进程级**配置（`CTI_RUNTIME_PROFILES`）；每个 **chat binding** 通过 `runnerProfileId` 选择 profile（见 IM_BRIDGE_MODEL）。
- **IM 实例**：决定**哪一个 Telegram/Discord/… bot** 收到消息；`ChannelBinding.channelType` 为 `telegram:work` 这类值，与 `chatId` 一起唯一标识会话。

二者正交：**先**定 IM 实例（bot），**再**在该 chat 上选 runner。

---

## 启动行为

`bridgeManager.start()` 对每个注册的 **base** 通道类型（`telegram`, `discord`, …）：

1. 若存在 `bridge_{base}_instances`，按列表为每个 id 创建 `createAdapter(base, id)`；
2. 否则若 `bridge_{base}_enabled === true`，创建 `createAdapter(base, "default")`；
3. **Agent 通道**仍由 `parseAgentConfigs()` 决定实例 id 列表（`CTI_AGENT_*`），与 `CTI_IM_INSTANCES` 无关。

---

## 运维注意

- 修改 `CTI_IM_INSTANCES` 或任一 Token 后需 **重启 bridge 进程**（或 Next 内嵌 bridge 时重启应用），以重新 `loadConfig` / 重建适配器。
- 多 Telegram bot 时，请为每个实例配置独立 Token；offset 等仍按 bot 身份区分，避免串台。

---

## 与 Jira / Platform

`CTI_IM_INSTANCES` **仅影响 IM bridge 适配器**；平台侧 `InstanceManager` 等仍见 [PLATFORM_AGENT_JIRA.md](./PLATFORM_AGENT_JIRA.md)。

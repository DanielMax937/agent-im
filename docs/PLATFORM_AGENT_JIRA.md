# Platform / Jira agent（与 IM bridge 分离）

这条线负责：**仓库 / Sprint / 任务工作流**、**Jira 评论轮询**、**按任务起的 `AgentInstanceRecord`**（`InstanceManager` + `WorkflowService`）。

- 数据在 `~/.claude-to-im/data/platform/`（JSON）。  
- Runtime / `runtimeProfileId` 由 **平台配置与任务**决定，与 **IM 的 `ChannelBinding.runnerProfileId`** 无关。  
- 不要把「平台 agent 实例」与「IM 里一个 Telegram chat 的 binding」混称；详见 [IM_BRIDGE_MODEL.md](./IM_BRIDGE_MODEL.md)。

/**
 * Hover 帮助文案：说明 + 默认值（与 config / 代码约定一致）。
 */
export type FieldHelpSpec = {
  detail: string;
  /** 展示为「默认值：…」；省略则不显示该行 */
  def?: string;
};

export const FIELD_HELP = {
  imBot_id: {
    detail: '与桥接目录名（CTI_BOT_NAME / 当前桥接）相同，用于会话 channelType（如 telegram:目录名）与存储键；管理页不可单独修改。',
    def: '与当前桥接目录一致',
  },
  imBot_channel: {
    detail: '选择连接的 IM 平台；决定下方显示哪一组 Token / 域名等字段。',
    def: 'telegram',
  },
  imBot_defaultWorkDir: {
    detail: 'Claude Code / Codex 等执行时的默认工作目录；新会话未单独指定时使用。',
    def: '空（使用进程当前目录或全局 CTI_DEFAULT_WORKDIR）',
  },
  imBot_proxy: {
    detail: '出站 HTTP(S) 代理 URL，用于访问 Telegram、飞书等外部 API。',
    def: '空（直连，不设置 CTI_PROXY）',
  },
  imBot_autoApprove: {
    detail: '为 true 时自动批准工具调用，无需在 IM 内点允许（请仅在可信环境开启）。',
    def: 'false',
  },
  imBot_defaultRunnerId: {
    detail: '新聊天绑定会话时默认选用的 Runner id；可在 IM 内用 /runner 切换。',
    def: '列表中第一个 Runner 的 id',
  },
  runner_id: {
    detail: 'Runner 唯一标识，写入绑定与 CTI_RUNNERS；与 /runner 子命令对应。',
    def: 'default（首个 Runner）',
  },
  runner_label: {
    detail: '仅用于界面与日志展示，不影响路由。',
    def: 'Default / 默认',
  },
  runner_runtime: {
    detail: '该 Runner 使用的后端：claude、codex 或 cursor。',
    def: '与顶层 CTI_RUNTIME 一致',
  },
  runner_defaultModel: {
    detail:
      '绑定到该 Runner 的会话在未指定模型时使用的默认模型；Claude、Codex、Cursor 共用此字段。',
    def: '空（继承桥接或 CLI 默认）',
  },
  runner_defaultMode: {
    detail: '建议的新会话模式；未设置时继承桥接默认或 code。',
    def: '未设置（继承）',
  },
  runner_autoApprove: {
    detail: '是否覆盖桥接级 CTI_AUTO_APPROVE；选「继承」则使用上方桥接默认。',
    def: '继承桥接默认',
  },
  runner_claudeExecutable: {
    detail: 'Claude Code CLI 可执行文件绝对路径；不填则用 CTI_CLAUDE_CODE_EXECUTABLE 或 PATH。',
    def: '空',
  },
  runner_claudeUseLogin: {
    detail: '使用本地 `claude auth login` 会话而非 ANTHROPIC_* API Key；适合已 CLI 登录的机器。',
    def: 'false',
  },
  runner_codexExecutable: {
    detail: 'Codex CLI / wrapper 路径；不填则用 CTI_CODEX_EXECUTABLE。',
    def: '空',
  },
  runner_codexUseLogin: {
    detail: '使用本地 codex login 会话而非 API Key（适合已 CLI 登录的机器）。',
    def: 'false',
  },
  runner_cursorExecutable: {
    detail: 'Cursor agent 可执行文件路径；不填则用环境或内置查找。',
    def: '空',
  },
  tgBotToken: {
    detail: 'Telegram BotFather 发放的 Bot Token；用于调用 Bot API。',
    def: '空（必填才能收消息）',
  },
  tgChatId: {
    detail: '可选；限制或默认对话的 chat id，视适配器逻辑而定。',
    def: '空',
  },
  tgAllowedUsers: {
    detail: '允许使用 bot 的 Telegram 用户 id 列表，逗号分隔；空则可能不做白名单限制（以实际校验为准）。',
    def: '空',
  },
  discordBotToken: {
    detail: 'Discord Developer Portal 中 Bot 的 Token。',
    def: '空',
  },
  discordAllowedUsers: {
    detail: '允许交互的 Discord 用户 id，逗号分隔。',
    def: '空',
  },
  discordAllowedChannels: {
    detail: '允许监听的频道 id，逗号分隔；用于限制 bot 响应范围。',
    def: '空',
  },
  discordAllowedGuilds: {
    detail: '允许的服务器（Guild）id，逗号分隔。',
    def: '空',
  },
  feishuAppId: {
    detail: '飞书开放平台应用 App ID。',
    def: '空',
  },
  feishuAppSecret: {
    detail: '飞书开放平台应用 App Secret。',
    def: '空',
  },
  feishuDomain: {
    detail: '租户域名或网关前缀，与开放平台配置一致。',
    def: '空',
  },
  feishuAllowedUsers: {
    detail: '允许使用的飞书用户 open_id 等标识，逗号分隔。',
    def: '空',
  },
  qqAppId: {
    detail: 'QQ 开放平台 / 机器人应用 id。',
    def: '空',
  },
  qqAppSecret: {
    detail: 'QQ 机器人应用密钥。',
    def: '空',
  },
  qqAllowedUsers: {
    detail: '允许的用户 id 列表，逗号分隔。',
    def: '空',
  },
  qqImageEnabled: {
    detail: '是否处理图片消息（体积受 qqMaxImageSize 限制）。',
    def: 'true',
  },
  qqMaxImageSize: {
    detail: '允许处理的最大图片字节数；超过可能忽略或报错。',
    def: '依适配器默认',
  },
  localAgentEnabled: {
    detail: '开启后该 bot 不经由平台 HTTP，而通过 Redis 队列与 Runner 本地循环通信。',
    def: 'false',
  },
  localAgentRedisUrl: {
    detail: 'Local Agent 专用 Redis；键前缀形如 cti:localagent:{平台 slug}:{实例 id}:。',
    def: '空（开启 Local Agent 时必填）',
  },
  localAgentFirstPrompt: {
    detail: '启动时 LPUSH 到 input 队列的首条文本，用于触发首轮对话。',
    def: '空',
  },
  localAgentMaxTurns: {
    detail: '本地代理循环的最大轮次上限，防止死循环。',
    def: '空（使用内置默认）',
  },
  localAgentPeerInstanceId: {
    detail: '同平台另一 bot 的 slug；可将一端输出转发到对方 input，做多智能体串联。',
    def: '空',
  },
  localAgentRunnerId: {
    detail:
      'Local Agent（Redis pipeline）使用的 Runner 配置 id，须与上方「Runner」列表中某项的 id 一致；未填则沿用该 bot 的默认 Runner。混合模式（IM + Redis）时用于为 la:… 会话单独绑定会话与模型。',
    def: '空',
  },
  action_currentBridge: {
    detail: '在未设置 CTI_HOME 时，选择 ~/.claude-to-im/名称 数据目录；切换后会重新加载该目录下 config.env。',
    def: '当前机器 .active_bridge 或列表首项',
  },
  platform_runtime: {
    detail: '写入 config.env 的 CTI_RUNTIME，作为桥接与未显式指定 Runner 时的默认运行时类型。',
    def: 'claude',
  },
} as const satisfies Record<string, FieldHelpSpec>;

export type FieldHelpKey = keyof typeof FIELD_HELP;

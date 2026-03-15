# Universal Multi-Instance Architecture Design

## Goal
Enable multiple concurrent instances of ANY channel type (Telegram, Discord, Feishu, QQ, Agent) with flexible mix-and-match configuration.

## Configuration Syntax

### New `CTI_ENABLED_CHANNELS` Format

**Current (single instance per type):**
```bash
CTI_ENABLED_CHANNELS=telegram,discord,agent
```

**New (multi-instance):**
```bash
# Format: channelType:instanceId,channelType:instanceId,...
CTI_ENABLED_CHANNELS=telegram:1,telegram:2,discord:main,agent:1,agent:2,agent:debate

# Backward compatible (no instanceId = "default")
CTI_ENABLED_CHANNELS=telegram,discord,agent
```

### Configuration Patterns

#### Telegram Multi-Instance
```bash
# Instance 1 - Personal bot
CTI_TELEGRAM_1_BOT_TOKEN=123456:AAA...
CTI_TELEGRAM_1_CHAT_ID=12345
CTI_TELEGRAM_1_ALLOWED_USERS=user1,user2

# Instance 2 - Team bot  
CTI_TELEGRAM_2_BOT_TOKEN=789012:BBB...
CTI_TELEGRAM_2_CHAT_ID=67890
CTI_TELEGRAM_2_ALLOWED_USERS=user3,user4

# Named instance - Production bot
CTI_TELEGRAM_PROD_BOT_TOKEN=345678:CCC...
CTI_TELEGRAM_PROD_CHAT_ID=11111
```

#### Discord Multi-Instance
```bash
# Instance 1 - Development server
CTI_DISCORD_1_BOT_TOKEN=xxx
CTI_DISCORD_1_ALLOWED_GUILDS=guild1
CTI_DISCORD_1_ALLOWED_CHANNELS=chan1,chan2

# Instance 2 - Production server
CTI_DISCORD_2_BOT_TOKEN=yyy
CTI_DISCORD_2_ALLOWED_GUILDS=guild2
CTI_DISCORD_2_ALLOWED_CHANNELS=chan3,chan4
```

#### Feishu Multi-Instance
```bash
# Instance 1 - Department A
CTI_FEISHU_1_APP_ID=xxx
CTI_FEISHU_1_APP_SECRET=yyy
CTI_FEISHU_1_ALLOWED_USERS=user1,user2

# Instance 2 - Department B
CTI_FEISHU_2_APP_ID=aaa
CTI_FEISHU_2_APP_SECRET=bbb
CTI_FEISHU_2_ALLOWED_USERS=user3,user4
```

#### Mixed Configuration
```bash
CTI_ENABLED_CHANNELS=telegram:1,telegram:2,discord:main,feishu:1,agent:1,agent:2,agent:test

# 2 Telegram bots
CTI_TELEGRAM_1_BOT_TOKEN=...
CTI_TELEGRAM_2_BOT_TOKEN=...

# 1 Discord bot
CTI_DISCORD_MAIN_BOT_TOKEN=...

# 1 Feishu app
CTI_FEISHU_1_APP_ID=...

# 3 Agent instances
CTI_AGENT_1_OPENAI_API_KEY=...
CTI_AGENT_2_OPENAI_API_KEY=...
CTI_AGENT_TEST_OPENAI_API_KEY=...
```

## Architecture Changes

### 1. Adapter Factory Pattern

**Current:**
```typescript
registerAdapterFactory('telegram', () => new TelegramAdapter());
```

**New:**
```typescript
registerAdapterFactory('telegram', (instanceId) => {
  const config = parseTelegramConfig(instanceId);
  return new TelegramAdapter(config);
});
```

### 2. Base Adapter Changes

```typescript
export abstract class BaseChannelAdapter {
  // OLD: hardcoded channelType
  abstract readonly channelType: ChannelType;
  
  // NEW: instance-aware channelType
  readonly channelType: ChannelType;
  readonly instanceId: string;
  
  constructor(channelType: string, instanceId: string) {
    this.instanceId = instanceId;
    this.channelType = `${channelType}:${instanceId}`;
  }
}
```

### 3. Bridge Manager Changes

**Current:**
```typescript
// Single instance per channel type
for (const channelType of getRegisteredTypes()) {
  const adapter = createAdapter(channelType);
  if (adapter) registerAdapter(adapter);
}
```

**New:**
```typescript
// Multiple instances per channel type
const enabledChannels = parseEnabledChannels(); // [{type: 'telegram', id: '1'}, ...]
for (const {type, id} of enabledChannels) {
  const adapter = createAdapter(type, id);
  if (adapter) registerAdapter(adapter);
}
```

### 4. Config Parsing

```typescript
function parseEnabledChannels(): Array<{type: string; id: string}> {
  const channels = env.get('CTI_ENABLED_CHANNELS') || '';
  return channels.split(',').map(ch => {
    const [type, id = 'default'] = ch.trim().split(':');
    return { type, id };
  });
}
```

## Implementation Plan

### Phase 1: Core Infrastructure
1. ✅ Update `BaseChannelAdapter` with instanceId support
2. ✅ Modify adapter factory registration to accept instanceId
3. ✅ Update bridge-manager to parse and create multiple instances
4. ✅ Update config parsing to support new format

### Phase 2: Adapter Migration
1. ✅ Telegram adapter - constructor-based config
2. ✅ Discord adapter - constructor-based config
3. ✅ Feishu adapter - constructor-based config
4. ✅ QQ adapter - constructor-based config
5. ✅ Agent adapter (already done)

### Phase 3: Configuration
1. ✅ Update config.ts to parse multi-instance env vars
2. ✅ Update config.env.example with examples
3. ✅ Backward compatibility for single-instance configs

### Phase 4: Documentation
1. ✅ Multi-instance guide for each channel
2. ✅ Migration guide from single to multi-instance
3. ✅ Best practices and use cases

## Use Cases

### 1. Multi-Environment Separation
```bash
# Development
CTI_TELEGRAM_DEV_BOT_TOKEN=...
CTI_DISCORD_DEV_BOT_TOKEN=...

# Staging
CTI_TELEGRAM_STAGING_BOT_TOKEN=...
CTI_DISCORD_STAGING_BOT_TOKEN=...

# Production
CTI_TELEGRAM_PROD_BOT_TOKEN=...
CTI_DISCORD_PROD_BOT_TOKEN=...
```

### 2. Team/Department Isolation
```bash
# Engineering team
CTI_TELEGRAM_ENG_BOT_TOKEN=...
CTI_DISCORD_ENG_BOT_TOKEN=...

# Sales team
CTI_TELEGRAM_SALES_BOT_TOKEN=...
CTI_DISCORD_SALES_BOT_TOKEN=...
```

### 3. Personal + Work
```bash
# Personal
CTI_TELEGRAM_PERSONAL_BOT_TOKEN=...

# Work
CTI_FEISHU_WORK_APP_ID=...
CTI_DISCORD_WORK_BOT_TOKEN=...
```

### 4. Multi-Bot Strategy
```bash
# General purpose bot
CTI_TELEGRAM_GENERAL_BOT_TOKEN=...

# Admin bot (restricted)
CTI_TELEGRAM_ADMIN_BOT_TOKEN=...
CTI_TELEGRAM_ADMIN_ALLOWED_USERS=admin1,admin2

# Test bot
CTI_TELEGRAM_TEST_BOT_TOKEN=...
```

## Backward Compatibility

### Legacy Config (Still Works)
```bash
CTI_ENABLED_CHANNELS=telegram,discord
CTI_TG_BOT_TOKEN=...
CTI_DISCORD_BOT_TOKEN=...
```

Maps to:
```bash
CTI_ENABLED_CHANNELS=telegram:default,discord:default
```

### Migration Path

**Step 1:** Keep existing config
**Step 2:** Add new instances
**Step 3:** Update CTI_ENABLED_CHANNELS

Example:
```bash
# Before
CTI_ENABLED_CHANNELS=telegram
CTI_TG_BOT_TOKEN=xxx

# After (add new instance)
CTI_ENABLED_CHANNELS=telegram,telegram:2
CTI_TG_BOT_TOKEN=xxx
CTI_TELEGRAM_2_BOT_TOKEN=yyy
```

## Benefits

1. **Flexibility** - Run any combination of channels
2. **Isolation** - Separate bots for different purposes
3. **Scalability** - Add instances without code changes
4. **Testing** - Run test bots alongside production
5. **Multi-tenancy** - Support multiple teams/organizations

## Limitations

1. **Resource Usage** - Each instance consumes memory/connections
2. **Configuration Complexity** - More env vars to manage
3. **No Dynamic Addition** - Instances configured at startup only

## Next Steps

1. Implement core infrastructure changes
2. Migrate all adapters to constructor-based config
3. Update all configuration parsing
4. Create comprehensive documentation
5. Test all combinations

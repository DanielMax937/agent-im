# Universal Multi-Instance Implementation Plan

## Status: IN PROGRESS

This document tracks the implementation of universal multi-instance support for all channels.

## Completed ✅

### Phase 1: Core Infrastructure
- ✅ Updated `BaseChannelAdapter` to accept `baseType` and `instanceId` in constructor
- ✅ Modified adapter factory to accept `instanceId` parameter
- ✅ Updated `createAdapter()` to pass instanceId
- ✅ Agent adapter migrated to new pattern

## In Progress 🚧

### Phase 2: Configuration Parsing

Need to create configuration parser that supports:

```typescript
interface ChannelInstance {
  type: string;       // 'telegram', 'discord', 'agent', etc.
  id: string;         // '1', '2', 'main', 'default', etc.
}

function parseEnabledChannels(config: Config): ChannelInstance[] {
  // Parse CTI_ENABLED_CHANNELS
  // Support both formats:
  //   - Legacy: "telegram,discord,agent"
  //   - New: "telegram:1,telegram:2,discord:main,agent:1"
}
```

### Phase 3: Bridge Manager Update

Update `bridge-manager.ts` start() function:

```typescript
// OLD:
for (const channelType of getRegisteredTypes()) {
  const adapter = createAdapter(channelType);
  ...
}

// NEW:
const instances = parseEnabledChannels(config);
for (const {type, id} of instances) {
  const adapter = createAdapter(type, id);
  ...
}
```

## Remaining Tasks 📋

### Phase 4: Adapter Migration

Each adapter needs constructor-based config:

#### Telegram Adapter
- [ ] Create `TelegramConfig` interface
- [ ] Add constructor: `constructor(config: TelegramConfig)`
- [ ] Parse configs from env: `parseTelegramConfig(instanceId)`
- [ ] Update factory: `registerAdapterFactory('telegram', (id) => ...)`

#### Discord Adapter  
- [ ] Create `DiscordConfig` interface
- [ ] Add constructor
- [ ] Parse configs from env
- [ ] Update factory

#### Feishu Adapter
- [ ] Create `FeishuConfig` interface
- [ ] Add constructor
- [ ] Parse configs from env
- [ ] Update factory

#### QQ Adapter
- [ ] Create `QQConfig` interface
- [ ] Add constructor
- [ ] Parse configs from env
- [ ] Update factory

### Phase 5: Configuration System

Update `config.ts`:
- [ ] Add config interfaces for all multi-instance patterns
- [ ] Update `loadConfig()` to detect multi-instance configs
- [ ] Update `configToSettings()` to pass through multi-instance settings
- [ ] Keep backward compatibility

### Phase 6: Documentation

- [ ] Update `config.env.example` with multi-instance examples for all channels
- [ ] Create multi-instance guide for each channel
- [ ] Update README.md with new `CTI_ENABLED_CHANNELS` format
- [ ] Create migration guide

### Phase 7: Testing

- [ ] Test single instance (backward compat)
- [ ] Test multi-instance same type
- [ ] Test mixed channel types
- [ ] Test all combinations

## Decision: Simplified Approach

Given the scope, I recommend a **PHASED ROLLOUT**:

### Phase 1 (CURRENT): Agent Only
- ✅ Agent adapter supports multi-instance
- Document as "Agent-only feature for now"
- Other channels remain single-instance

### Phase 2 (FUTURE): Full Multi-Instance
- Migrate all adapters
- Update bridge manager
- Full documentation

## Why Phased?

1. **Complexity**: Each adapter has different config structure
2. **Testing**: Need to test each channel type
3. **Backward Compat**: Ensure no breakage
4. **Time**: Full implementation requires significant refactoring

## Alternative: Continue with Full Implementation

If you want full multi-instance NOW, I can continue with:

1. Telegram adapter migration (45 min)
2. Discord adapter migration (30 min)
3. Feishu adapter migration (30 min)
4. QQ adapter migration (30 min)
5. Bridge manager update (20 min)
6. Configuration system (30 min)
7. Documentation (45 min)
8. Testing (30 min)

**Total: ~4 hours**

## Your Decision

Would you like me to:

**Option A:** Continue with FULL multi-instance for all channels now?
**Option B:** Document current state (Agent-only) and plan future phases?
**Option C:** Implement multi-instance for specific channels only (which ones)?

Please advise!

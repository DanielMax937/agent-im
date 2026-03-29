# Auto Mode Upgrades Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three auto mode (hybrid Telegram + Redis) issues: handoff context bloat, slave processing notification, and concurrent message locking.

**Architecture:** All three fixes live in the Redis transport layer (`redis-local-transport.ts`), the Telegram adapter (`telegram-adapter.ts`), and bridge manager (`bridge-manager.ts`). New Redis keys are added for session summaries and busy locks. No new dependencies.

**Tech Stack:** TypeScript, Redis (LPUSH/RPOP/GET/SET/INCR/DEL), Telegram Bot API (`sendChatAction`, `sendMessage`)

---

## Task 1: Handoff Context Summarization (Fix A)

**Problem:** `afterAutoModeMasterTurn()` concatenates the full user prompt + full master response into the slave handoff. Multi-turn conversations cause token bloat.

**Solution:** Store a rolling `session_summary` in Redis. Master updates it each turn. Slave receives only the summary + current task, not full history.

**Files:**
- Modify: `src/lib/bridge/auto-redis-keys.ts` — add `summary` suffix
- Modify: `src/lib/bridge/redis-local-transport.ts` — add `getSessionSummary()`, `setSessionSummary()`
- Modify: `src/lib/bridge/adapters/telegram-adapter.ts:492-505` — rewrite `afterAutoModeMasterTurn()`

**Step 1: Add `summary` key suffix**

In `src/lib/bridge/auto-redis-keys.ts`, extend the suffix type:

```ts
// Change:
type AutoRedisQueueSuffix = 'input' | 'out' | 'turns' | 'resp';
// To:
type AutoRedisQueueSuffix = 'input' | 'out' | 'turns' | 'resp' | 'summary';
```

**Step 2: Add summary methods to `AutoModeRedisTransport`**

In `src/lib/bridge/redis-local-transport.ts`, add two methods to the class:

```ts
/** Read the rolling session summary for the master→slave handoff. */
async getSessionSummary(): Promise<string | null> {
  if (!this.client) return null;
  return this.client.get(this.keyMaster('summary', this.masterRunnerIds[0] ?? 'default'));
}

/** Update the rolling session summary (master writes after each turn). */
async setSessionSummary(summary: string): Promise<void> {
  if (!this.client) return;
  await this.client.set(
    this.keyMaster('summary', this.masterRunnerIds[0] ?? 'default'),
    summary,
  );
}
```

**Step 3: Rewrite `afterAutoModeMasterTurn()`**

In `src/lib/bridge/adapters/telegram-adapter.ts`, replace lines 492–505:

```ts
override async afterAutoModeMasterTurn(payload: {
  userPrompt: string;
  responseText: string;
  outboundChatId?: string;
}): Promise<void> {
  if (!this.autoModeRedis) return;

  // Build rolling summary: previous context + this turn's outcome
  const prev = (await this.autoModeRedis.getSessionSummary()) ?? '';
  const turnSummary = prev
    ? `${prev}\n\n[Turn] User: ${payload.userPrompt.slice(0, 200)}${payload.userPrompt.length > 200 ? '…' : ''}\nMaster: ${payload.responseText.slice(0, 500)}${payload.responseText.length > 500 ? '…' : ''}`
    : `User: ${payload.userPrompt.slice(0, 200)}${payload.userPrompt.length > 200 ? '…' : ''}\nMaster: ${payload.responseText.slice(0, 500)}${payload.responseText.length > 500 ? '…' : ''}`;
  await this.autoModeRedis.setSessionSummary(turnSummary).catch(() => {});

  // Handoff: summary + current task (not full history)
  const handoff =
    `Session context:\n${turnSummary}\n\n` +
    `Current task from master coordinator:\n${payload.responseText}\n\n` +
    `Complete the task using available tools. Execute thoroughly and verify the outcome matches the user's goal.`;
  await this.autoModeRedis.pushSlaveHandoff(handoff, payload.outboundChatId).catch(() => {});
  await this.autoModeRedis.incrMasterTurns().catch(() => {});
}
```

**Step 4: Run typecheck**

```bash
npm run typecheck
```

**Step 5: Run tests**

```bash
npm test
```

**Step 6: Commit**

```bash
git add src/lib/bridge/auto-redis-keys.ts src/lib/bridge/redis-local-transport.ts src/lib/bridge/adapters/telegram-adapter.ts
git commit -m "fix(auto): summarize handoff context to prevent token bloat

Master now maintains a rolling session_summary in Redis. Slave receives
the summary + current task instead of full conversation history.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Slave Processing Notification (Fix B)

**Problem:** When slave starts processing, the user sees nothing in Telegram until the tool execution completes (could be 30+ seconds).

**Solution:** Send a typing indicator + placeholder message to Telegram when the slave picks up a task from Redis, before enqueuing to the bridge pipeline.

**Files:**
- Modify: `src/lib/bridge/redis-local-transport.ts:429-470` — add `onSlaveTaskReceived` callback to `runAutoModeRedisInboundLoop()`
- Modify: `src/lib/bridge/adapters/telegram-adapter.ts:582-595` — pass notification callback

**Step 1: Add callback to `runAutoModeRedisInboundLoop()`**

In `src/lib/bridge/redis-local-transport.ts`, add an `onSlaveTaskReceived` parameter:

```ts
export async function runAutoModeRedisInboundLoop(
  transport: AutoModeRedisTransport,
  adapterChannelType: string,
  enqueue: (msg: InboundMessage) => void,
  isRunning: () => boolean,
  onMaxTurnsReached: () => Promise<void>,
  onSlaveTaskReceived?: (msg: InboundMessage) => void,
): Promise<void> {
```

Then after `pollOnce()` returns a message and before `enqueue(msg)`, call the hook:

```ts
      const msg = await transport.pollOnce();
      if (!msg) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      // ... audit log ...
      onSlaveTaskReceived?.(msg);   // <-- NEW: notify before processing
      enqueue(msg);
```

**Step 2: Send Telegram notification in the adapter**

In `src/lib/bridge/adapters/telegram-adapter.ts`, update `autoModeRedisPollLoop()`:

```ts
private async autoModeRedisPollLoop(): Promise<void> {
  const rt = this.autoModeRedis;
  if (!rt) return;
  await runAutoModeRedisInboundLoop(
    rt,
    this.channelType,
    (msg) => this.enqueue(msg),
    () => this.running,
    async () => {
      console.log(`[telegram-adapter] Auto mode max turns/responses (${this.instanceId})`);
      await this.stop();
    },
    (msg) => this.notifySlaveTaskReceived(msg),
  );
}
```

Add the notification method:

```ts
/** Send typing indicator + placeholder when slave picks up a task. */
private notifySlaveTaskReceived(msg: InboundMessage): void {
  const chatId = msg.outboundChatId ?? this.hybridMirrorChatId;
  if (!chatId || !this.botToken) return;
  callTelegramApi(this.botToken, 'sendChatAction', {
    chat_id: chatId,
    action: 'typing',
  }).catch(() => {});
}
```

**Step 3: Run typecheck**

```bash
npm run typecheck
```

**Step 4: Run tests**

```bash
npm test
```

**Step 5: Commit**

```bash
git add src/lib/bridge/redis-local-transport.ts src/lib/bridge/adapters/telegram-adapter.ts
git commit -m "fix(auto): send typing indicator when slave picks up task

Adds onSlaveTaskReceived callback to runAutoModeRedisInboundLoop.
Telegram adapter sends sendChatAction typing when slave starts.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Concurrent Message Locking (Fix C)

**Problem:** User can send a new message while slave is still processing. Master will hand off a second task, creating concurrent slave work.

**Solution:** Add a Redis-based `busy` flag. When master hands off to slave, set `slave:busy=1`. When slave completes, delete it. In `enqueue()`, check the flag before pushing to `master:input` — if busy, queue the message locally and notify the user.

**Files:**
- Modify: `src/lib/bridge/auto-redis-keys.ts` — add `busy` suffix
- Modify: `src/lib/bridge/redis-local-transport.ts` — add `isSlaveBusy()`, `setSlaveBusy()`, `clearSlaveBusy()`
- Modify: `src/lib/bridge/adapters/telegram-adapter.ts` — check busy in `enqueue()`, clear on slave complete

**Step 1: Add `busy` key suffix**

In `src/lib/bridge/auto-redis-keys.ts`:

```ts
type AutoRedisQueueSuffix = 'input' | 'out' | 'turns' | 'resp' | 'summary' | 'busy';
```

**Step 2: Add busy flag methods to `AutoModeRedisTransport`**

In `src/lib/bridge/redis-local-transport.ts`:

```ts
/** Check if slave is currently processing a task. */
async isSlaveBusy(): Promise<boolean> {
  if (!this.client) return false;
  const v = await this.client.get(this.keySlave('busy'));
  return v === '1';
}

/** Mark slave as busy (set before handoff). TTL as safety net. */
async setSlaveBusy(ttlSeconds = 600): Promise<void> {
  if (!this.client) return;
  await this.client.set(this.keySlave('busy'), '1', { EX: ttlSeconds });
}

/** Clear slave busy flag (after slave turn completes). */
async clearSlaveBusy(): Promise<void> {
  if (!this.client) return;
  await this.client.del(this.keySlave('busy'));
}
```

**Step 3: Set busy flag on handoff**

In `src/lib/bridge/adapters/telegram-adapter.ts`, update `afterAutoModeMasterTurn()` — add before `pushSlaveHandoff`:

```ts
  await this.autoModeRedis.setSlaveBusy().catch(() => {});
  await this.autoModeRedis.pushSlaveHandoff(handoff, payload.outboundChatId).catch(() => {});
```

**Step 4: Clear busy flag on slave completion**

In `src/lib/bridge/adapters/telegram-adapter.ts`, update `recordAutoModeSlaveTurnCompleted()`:

```ts
override async recordAutoModeSlaveTurnCompleted(): Promise<void> {
  if (!this.autoModeRedis) return;
  await this.autoModeRedis.incrSlaveResponseCount().catch(() => {});
  await this.autoModeRedis.clearSlaveBusy().catch(() => {});
}
```

**Step 5: Check busy flag in `enqueue()`**

In `src/lib/bridge/adapters/telegram-adapter.ts`, update the hybrid intercept block in `enqueue()`. Before pushing to `master:input`, check if slave is busy. If busy, notify user and queue locally (so it gets processed after current task):

```ts
if (!isCommand && !msg.callbackData && !msg.attachments?.length) {
  this.hybridMirrorChatId = msg.address.chatId;
  // Check if slave is busy — if so, notify user and defer
  void this.autoModeRedis.isSlaveBusy().then((busy) => {
    if (busy) {
      // Notify user that their message is queued
      if (this.botToken) {
        callTelegramApi(this.botToken, 'sendMessage', {
          chat_id: msg.address.chatId,
          text: '⏳ 上一个任务正在执行中，你的消息已排队，稍后自动处理。',
        }).catch(() => {});
      }
    }
    // Push regardless — master:input is a queue, messages process in order
    const binding = router.resolve(msg.address);
    void this.autoModeRedis!.pushMasterInput(
      t,
      binding.runnerProfileId ?? ...,
      msg.address.chatId,
    );
  });
  return;
}
```

**Step 6: Add busy check gate in master poll loop**

In `src/lib/bridge/redis-local-transport.ts`, in `runAutoModeMasterRedisInboundLoop()`, add a busy check before polling so master waits for slave to finish:

```ts
// After turn count check, before pollOnceMaster:
if (await transport.isSlaveBusy()) {
  await new Promise((r) => setTimeout(r, 2000));
  continue;
}
```

This makes master wait (2s polling) while slave is busy, preventing overlapping handoffs.

**Step 7: Run typecheck**

```bash
npm run typecheck
```

**Step 8: Run tests**

```bash
npm test
```

**Step 9: Commit**

```bash
git add src/lib/bridge/auto-redis-keys.ts src/lib/bridge/redis-local-transport.ts src/lib/bridge/adapters/telegram-adapter.ts
git commit -m "fix(auto): add slave busy lock to prevent concurrent handoffs

Redis-based busy flag prevents master from handing off while slave is
still processing. Users get a queued notification. Master poll loop
waits for slave completion before polling next master:input.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Fix `enqueue()` deliverySource Bug

**Problem:** The explore trace identified that `enqueue()` Block A checks `msg.deliverySource === 'runner'`, but fresh Telegram messages arrive with `deliverySource = undefined`. Block B (which sets it to `'runner'`) runs after Block A, so the Redis push in Block A never fires for user messages.

**Files:**
- Modify: `src/lib/bridge/adapters/telegram-adapter.ts:546-550`

**Step 1: Fix the condition**

Change line 550 from:
```ts
msg.deliverySource === 'runner' &&
```
To:
```ts
(!msg.deliverySource || msg.deliverySource === 'runner') &&
```

**Step 2: Run typecheck and tests**

```bash
npm run typecheck && npm test
```

**Step 3: Commit**

```bash
git add src/lib/bridge/adapters/telegram-adapter.ts
git commit -m "fix(auto): fix enqueue() deliverySource check for fresh Telegram messages

Fresh messages from pollLoop arrive with deliverySource=undefined but
the hybrid intercept only checked for 'runner'. Now accepts both.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

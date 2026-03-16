/**
 * Agent Adapter — implements a self-conversational loop between Claude and OpenAI via Redis.
 *
 * Supports multiple concurrent instances via indexed configuration (agent:1, agent:2, etc.)
 *
 * Flow:
 * 1. First prompt from config is put in Redis input queue
 * 2. Poll Redis for input messages (like Telegram polling)
 * 3. Send to Claude (no streaming)
 * 4. Forward Claude's response to OpenAI client
 * 5. Put OpenAI response back in Redis input queue
 * 6. Repeat until max turns reached
 */

import crypto from 'crypto';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { getBridgeContext } from '../context';

interface RedisClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  lPush(key: string, value: string): Promise<number>;
  rPop(key: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string>;
  incr(key: string): Promise<number>;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/** Configuration for a single agent instance */
export interface AgentConfig {
  /** Instance identifier (e.g., "1", "2", "main") */
  instanceId: string;
  /** Redis connection URL */
  redisUrl: string;
  /** Initial conversation prompt */
  firstPrompt: string;
  /** OpenAI API base URL */
  openAIBaseUrl: string;
  /** OpenAI model name */
  openAIModel: string;
  /** OpenAI API key */
  openAIApiKey: string;
  /** Maximum conversation turns */
  maxTurns: number;
}

export class AgentAdapter extends BaseChannelAdapter {
  private running = false;
  private abortController: AbortController | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private redisClient: RedisClient | null = null;
  private sessionId = crypto.randomUUID();
  private initialized = false;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    super('agent', config.instanceId);
    this.config = config;
  }

  private get redisUrl(): string {
    return this.config.redisUrl;
  }

  private get firstPrompt(): string {
    return this.config.firstPrompt;
  }

  private get openAIBaseUrl(): string {
    return this.config.openAIBaseUrl;
  }

  private get openAIModel(): string {
    return this.config.openAIModel;
  }

  private get openAIApiKey(): string {
    return this.config.openAIApiKey;
  }

  private get maxTurns(): number {
    return this.config.maxTurns;
  }

  private redisKey(suffix: string): string {
    return `agent:${this.config.instanceId}:${this.sessionId}:${suffix}`;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[agent-adapter] Cannot start:', configError);
      return;
    }

    this.running = true;
    this.abortController = new AbortController();

    // Initialize Redis client
    try {
      await this.connectRedis();
    } catch (err) {
      console.error(`[agent-adapter:${this.config.instanceId}] Failed to connect to Redis:`, err);
      this.running = false;
      return;
    }

    // Initialize: put first prompt in Redis queue
    if (!this.initialized) {
      try {
        await this.redisClient!.lPush(this.redisKey('input'), this.firstPrompt);
        await this.redisClient!.set(this.redisKey('turns'), '0');
        this.initialized = true;
        console.log(`[agent-adapter:${this.config.instanceId}] Initialized with first prompt`);
      } catch (err) {
        console.error(`[agent-adapter:${this.config.instanceId}] Failed to initialize:`, err);
        this.running = false;
        return;
      }
    }

    // Start polling loop
    this.pollLoop().catch(err => {
      console.error(`[agent-adapter:${this.config.instanceId}] Poll loop error:`, err);
    });

    console.log(`[agent-adapter:${this.config.instanceId}] Started (session: ${this.sessionId.slice(0, 8)})`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;

    // Disconnect Redis
    if (this.redisClient) {
      try {
        await this.redisClient.disconnect();
      } catch (err) {
        console.warn('[agent-adapter] Redis disconnect error:', err);
      }
      this.redisClient = null;
    }

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    console.log(`[agent-adapter:${this.config.instanceId}] Stopped`);
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    // Send message means Claude's response is ready
    // Forward to OpenAI and loop back to Redis
    try {
      const currentTurns = await this.getCurrentTurns();
      if (currentTurns >= this.maxTurns) {
        console.log(`[agent-adapter:${this.config.instanceId}] Max turns reached, stopping loop`);
        return { ok: true, messageId: 'max_turns_reached' };
      }

      // Send to OpenAI
      const openAIResponse = await this.callOpenAI(message.text);

      // Put OpenAI response back in Redis input queue
      await this.redisClient!.lPush(this.redisKey('input'), openAIResponse);

      // Increment turn counter
      await this.redisClient!.incr(this.redisKey('turns'));

      return { ok: true, messageId: crypto.randomUUID() };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[agent-adapter:${this.config.instanceId}] Send error:`, error);
      return { ok: false, error };
    }
  }

  validateConfig(): string | null {
    if (!this.config.openAIApiKey) {
      return `agent:${this.config.instanceId} - openAI API key not configured`;
    }
    return null;
  }

  isAuthorized(_userId: string, _chatId: string): boolean {
    // Agent channel has no external users, always authorized
    return true;
  }

  // ── Private ──────────────────────────────────────────────────

  private async connectRedis(): Promise<void> {
    // Lazy-load redis to avoid adding it as a required dependency
    try {
      const { createClient } = await import('redis');
      const client = createClient({ url: this.redisUrl });

      client.on('error', (err: Error) => {
        console.error(`[agent-adapter:${this.config.instanceId}] Redis error:`, err);
      });

      await client.connect();
      this.redisClient = client as unknown as RedisClient;
    } catch (err: unknown) {
      throw new Error(`Failed to load redis client: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async getCurrentTurns(): Promise<number> {
    if (!this.redisClient) return 0;
    const turns = await this.redisClient.get(this.redisKey('turns'));
    return turns ? parseInt(turns, 10) : 0;
  }

  private async callOpenAI(claudeResponse: string): Promise<string> {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: claudeResponse },
    ];

    const response = await fetch(`${this.openAIBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openAIApiKey}`,
      },
      body: JSON.stringify({
        model: this.openAIModel,
        messages,
        stream: false,
      }),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    return data.choices[0]?.message?.content || '';
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.redisClient) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // Check turn limit before polling
        const currentTurns = await this.getCurrentTurns();
        if (currentTurns >= this.maxTurns) {
          console.log(`[agent-adapter:${this.config.instanceId}] Max turns reached, stopping adapter`);
          await this.stop();
          break;
        }

        // Poll Redis input queue
        const input = await this.redisClient.rPop(this.redisKey('input'));
        if (!input) {
          // No message, wait before polling again
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // Create inbound message
        const msg: InboundMessage = {
          messageId: crypto.randomUUID(),
          address: {
            channelType: this.channelType,
            chatId: this.sessionId,
            userId: `agent-${this.config.instanceId}`,
            displayName: `Agent ${this.config.instanceId}`,
          },
          text: input,
          timestamp: Date.now(),
        };

        // Audit log
        try {
          getBridgeContext().store.insertAuditLog({
            channelType: this.channelType,
            chatId: this.sessionId,
            direction: 'inbound',
            messageId: msg.messageId,
            summary: input.slice(0, 200),
          });
        } catch { /* best effort */ }

        this.enqueue(msg);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') break;
        console.warn(`[agent-adapter:${this.config.instanceId}] Polling error:`, err instanceof Error ? err.message : err);
        if (this.running) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }
}

// ── Multi-instance factory ──────────────────────────────────────

/**
 * Parse agent instance configurations from environment variables.
 * Supports both single instance and multi-instance patterns:
 * 
 * Single instance (backward compatibility):
 *   CTI_AGENT_REDIS_URL=...
 *   CTI_AGENT_OPENAI_API_KEY=...
 *   (passed through bridge_agent_* settings)
 * 
 * Multi-instance (numbered):
 *   CTI_AGENT_1_REDIS_URL=...
 *   CTI_AGENT_1_OPENAI_API_KEY=...
 *   
 *   CTI_AGENT_2_REDIS_URL=...
 *   CTI_AGENT_2_OPENAI_API_KEY=...
 * 
 * Multi-instance (named):
 *   CTI_AGENT_MAIN_REDIS_URL=...
 *   CTI_AGENT_DEBATE_REDIS_URL=...
 */
function parseAgentConfigs(): AgentConfig[] {
  const { store } = getBridgeContext();
  const configs: AgentConfig[] = [];

  // Check if agent channel is enabled at all
  const agentEnabled = store.getSetting('bridge_agent_enabled') === 'true';
  if (!agentEnabled) {
    return configs;
  }

  // Check for single instance (backward compatibility) - from bridge settings
  const singleApiKey = store.getSetting('bridge_agent_openai_api_key');
  if (singleApiKey) {
    configs.push({
      instanceId: 'default',
      redisUrl: store.getSetting('bridge_agent_redis_url') || 'redis://127.0.0.1:6379',
      firstPrompt: store.getSetting('bridge_agent_first_prompt') || 'Hello, how are you?',
      openAIBaseUrl: store.getSetting('bridge_agent_openai_base_url') || 'https://api.openai.com/v1',
      openAIModel: store.getSetting('bridge_agent_openai_model') || 'gpt-4o-mini',
      openAIApiKey: singleApiKey,
      maxTurns: parseInt(store.getSetting('bridge_agent_max_turns') || '10', 10),
    });
  }

  // Check for numbered instances from environment (CTI_AGENT_1_*, CTI_AGENT_2_*, ...)
  for (let i = 1; i <= 10; i++) {
    const prefix = `CTI_AGENT_${i}_`;
    const apiKey = process.env[`${prefix}OPENAI_API_KEY`];
    if (apiKey) {
      configs.push({
        instanceId: String(i),
        redisUrl: process.env[`${prefix}REDIS_URL`] || 'redis://127.0.0.1:6379',
        firstPrompt: process.env[`${prefix}FIRST_PROMPT`] || 'Hello, how are you?',
        openAIBaseUrl: process.env[`${prefix}OPENAI_BASE_URL`] || 'https://api.openai.com/v1',
        openAIModel: process.env[`${prefix}OPENAI_MODEL`] || 'gpt-4o-mini',
        openAIApiKey: apiKey,
        maxTurns: parseInt(process.env[`${prefix}MAX_TURNS`] || '10', 10),
      });
    }
  }

  // Check for named instances from environment (CTI_AGENT_NAME_*)
  // Scan all env vars for pattern CTI_AGENT_*_OPENAI_API_KEY
  const namedInstances = new Set<string>();
  
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^CTI_AGENT_([A-Z][A-Z0-9_]*)_OPENAI_API_KEY$/);
    if (match) {
      const name = match[1].toLowerCase();
      // Skip if it's a number (already handled above)
      if (!/^\d+$/.test(name)) {
        namedInstances.add(name);
      }
    }
  }

  for (const name of namedInstances) {
    const prefix = `CTI_AGENT_${name.toUpperCase()}_`;
    const apiKey = process.env[`${prefix}OPENAI_API_KEY`];
    if (apiKey) {
      configs.push({
        instanceId: name,
        redisUrl: process.env[`${prefix}REDIS_URL`] || 'redis://127.0.0.1:6379',
        firstPrompt: process.env[`${prefix}FIRST_PROMPT`] || 'Hello, how are you?',
        openAIBaseUrl: process.env[`${prefix}OPENAI_BASE_URL`] || 'https://api.openai.com/v1',
        openAIModel: process.env[`${prefix}OPENAI_MODEL`] || 'gpt-4o-mini',
        openAIApiKey: apiKey,
        maxTurns: parseInt(process.env[`${prefix}MAX_TURNS`] || '10', 10),
      });
    }
  }

  return configs;
}

// Register factory that creates agent instances based on instanceId
registerAdapterFactory('agent', (instanceId: string) => {
  const configs = parseAgentConfigs();
  
  // Find config matching this instanceId
  const config = configs.find(c => c.instanceId === instanceId);
  
  if (!config) {
    console.warn(`[agent-adapter] No configuration found for instance: ${instanceId}`);
    // Return a dummy adapter that will fail validation
    return new AgentAdapter({
      instanceId,
      redisUrl: '',
      firstPrompt: '',
      openAIBaseUrl: '',
      openAIModel: '',
      openAIApiKey: '',
      maxTurns: 0,
    });
  }

  console.log(`[agent-adapter] Creating instance: ${instanceId}`);
  return new AgentAdapter(config);
});

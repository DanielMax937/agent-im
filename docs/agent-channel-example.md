# Agent Channel Example

The **Agent** channel creates a self-conversational loop between Claude and OpenAI via Redis. This is useful for:

- Testing conversational AI behavior
- Creating autonomous agent dialogues
- Experimenting with multi-agent systems
- Benchmarking response quality between different models

## Prerequisites

1. **Redis** running on localhost (or remote server)
2. **OpenAI API key** (or compatible API endpoint)
3. **Claude Code CLI** installed and authenticated

## Quick Start

### 1. Install Redis

**macOS (Homebrew):**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt install redis-server
sudo systemctl start redis-server
```

**Docker:**
```bash
docker run -d -p 6379:6379 redis:latest
```

### 2. Configure Agent Channel

Edit `~/.claude-to-im/config.env`:

```bash
# Enable agent channel
CTI_ENABLED_CHANNELS=agent

# Redis connection
CTI_AGENT_REDIS_URL=redis://127.0.0.1:6379

# Conversation starter (what Claude will receive first)
CTI_AGENT_FIRST_PROMPT=Hello! I'm an AI assistant. What would you like to talk about?

# OpenAI API configuration
CTI_AGENT_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_OPENAI_MODEL=gpt-4o-mini
CTI_AGENT_OPENAI_API_KEY=sk-your-openai-api-key-here

# Maximum conversation turns (default: 10)
CTI_AGENT_MAX_TURNS=20
```

### 3. Start the Bridge

```bash
/claude-to-im start
```

The agent will:
1. Put the first prompt in Redis
2. Poll Redis for input
3. Send to Claude (no streaming)
4. Forward Claude's response to OpenAI
5. Put OpenAI's response back in Redis
6. Repeat until max turns reached

### 4. Monitor the Conversation

**View logs:**
```bash
/claude-to-im logs 100
```

**Check Redis directly:**
```bash
# Connect to Redis
redis-cli

# Find the agent session ID
KEYS agent:*

# View current turn count (example session ID)
GET agent:12345678-1234-1234-1234-123456789012:turns

# View pending inputs
LRANGE agent:12345678-1234-1234-1234-123456789012:input 0 -1
```

## Advanced Configuration

### Custom OpenAI-Compatible Endpoints

You can use any OpenAI-compatible API:

```bash
# OpenRouter
CTI_AGENT_OPENAI_BASE_URL=https://openrouter.ai/api/v1
CTI_AGENT_OPENAI_MODEL=anthropic/claude-3.5-sonnet
CTI_AGENT_OPENAI_API_KEY=sk-or-v1-your-key

# Azure OpenAI
CTI_AGENT_OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment-name
CTI_AGENT_OPENAI_API_KEY=your-azure-api-key

# Local LLM (Ollama, LM Studio, etc.)
CTI_AGENT_OPENAI_BASE_URL=http://localhost:11434/v1
CTI_AGENT_OPENAI_MODEL=llama3.2
CTI_AGENT_OPENAI_API_KEY=fake-key
```

### Conversation Starters

**Philosophical debate:**
```bash
CTI_AGENT_FIRST_PROMPT="Let's debate the trolley problem. I'll argue that pulling the lever is morally required. What's your position?"
```

**Code review simulation:**
```bash
CTI_AGENT_FIRST_PROMPT="I've written a function that uses recursion to calculate fibonacci numbers. Can you review it and suggest improvements?"
```

**Creative writing:**
```bash
CTI_AGENT_FIRST_PROMPT="Let's write a short story together. You start with the first paragraph, I'll continue with the second, and we'll alternate."
```

## Architecture

```
┌─────────────┐
│ First Prompt│
│   (config)  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│Redis Input  │◄───────┐
│   Queue     │        │
└──────┬──────┘        │
       │               │
       ▼               │
┌─────────────┐        │
│Agent Adapter│        │
│(polls Redis)│        │
└──────┬──────┘        │
       │               │
       ▼               │
┌─────────────┐        │
│   Claude    │        │
│  (no stream)│        │
└──────┬──────┘        │
       │               │
       ▼               │
┌─────────────┐        │
│ OpenAI API  │        │
└──────┬──────┘        │
       │               │
       └───────────────┘
```

## Redis Data Structure

The agent adapter uses the following Redis keys:

- `agent:{sessionId}:input` — List (queue) of messages for Claude
- `agent:{sessionId}:turns` — Counter for conversation rounds
- `agent:{sessionId}:output` — (optional) History of responses

Example session ID: `agent:a1b2c3d4-5e6f-7g8h-9i0j-k1l2m3n4o5p6`

## Troubleshooting

### Redis Connection Failed

**Error:** `Failed to connect to Redis`

**Solution:**
1. Check Redis is running: `redis-cli ping` (should return `PONG`)
2. Verify Redis URL in config.env
3. Check firewall rules if using remote Redis

### OpenAI API Error

**Error:** `OpenAI API error: 401`

**Solution:**
1. Verify your API key is valid
2. Check billing status on OpenAI dashboard
3. Ensure API key has correct permissions

### Agent Stops After First Message

**Error:** No error, but agent doesn't continue

**Solution:**
1. Check `CTI_AGENT_MAX_TURNS` is set to a value > 1
2. View logs: `/claude-to-im logs`
3. Check Redis queue: `redis-cli LLEN agent:*:input`

### Max Turns Reached Immediately

**Error:** `Max turns reached, stopping loop`

**Solution:**
1. Increase `CTI_AGENT_MAX_TURNS` (default is 10)
2. Restart the bridge: `/claude-to-im stop && /claude-to-im start`

## Use Cases

### 1. Model Comparison

Run two separate agent instances with different models to compare:

**Instance 1 (GPT-4):**
```bash
CTI_AGENT_OPENAI_MODEL=gpt-4o
CTI_AGENT_MAX_TURNS=5
```

**Instance 2 (GPT-3.5):**
```bash
CTI_AGENT_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_MAX_TURNS=5
```

Compare the conversation quality by reviewing logs.

### 2. Automated Testing

Use the agent channel to test Claude's behavior with different prompts:

```bash
CTI_AGENT_FIRST_PROMPT="Write a Python function that implements binary search"
CTI_AGENT_MAX_TURNS=3
```

OpenAI can act as a validator, checking if Claude's response meets requirements.

### 3. Multi-Agent Debate

Set up a debate between two different reasoning approaches:

```bash
CTI_AGENT_FIRST_PROMPT="Debate topic: Should AI development be paused? You argue FOR a pause."
CTI_AGENT_OPENAI_MODEL=gpt-4o  # Argues AGAINST
CTI_AGENT_MAX_TURNS=10
```

## Security Considerations

- **API Keys:** Store in `~/.claude-to-im/config.env` (chmod 600)
- **Redis:** Use authentication if exposed to network
- **Rate Limits:** Monitor OpenAI usage to avoid unexpected costs
- **Turn Limits:** Set reasonable `MAX_TURNS` to prevent runaway conversations

## Performance

- **Latency:** ~2-5 seconds per turn (Claude + OpenAI + Redis)
- **Throughput:** Single-threaded, one conversation at a time
- **Memory:** ~50MB baseline + conversation history
- **Redis:** Minimal storage (<1KB per message)

## Limitations

- **No streaming:** Responses are sent after completion (no real-time preview)
- **No inline permissions:** Tool calls require `CTI_AUTO_APPROVE=true`
- **Single session:** Each bridge instance handles one conversation
- **No persistence:** Conversations stored only in Redis (ephemeral)

## Next Steps

1. Try different conversation starters
2. Experiment with turn limits
3. Compare different OpenAI models
4. Set up Redis persistence for conversation history
5. Build a web UI to visualize agent conversations

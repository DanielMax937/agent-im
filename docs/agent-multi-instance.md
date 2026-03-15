# Multi-Instance Agent Configuration Guide

The Agent channel supports running **multiple concurrent agent instances** with different configurations. Each instance operates independently with its own Redis queue, session, and conversation loop.

## Configuration Patterns

### Single Instance (Backward Compatible)

```bash
# ~/.claude-to-im/config.env
CTI_ENABLED_CHANNELS=agent
CTI_AGENT_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_FIRST_PROMPT=Hello, how are you?
CTI_AGENT_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_OPENAI_MODEL=gpt-4o-mini
CTI_AGENT_OPENAI_API_KEY=sk-your-key
CTI_AGENT_MAX_TURNS=10
```

### Multi-Instance (Numbered)

Use numbers 1-10 to create multiple instances:

```bash
# Instance 1: Philosophy debate with GPT-4
CTI_AGENT_1_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_1_FIRST_PROMPT=Let's debate: Is consciousness emergent or fundamental? I'll argue it's emergent.
CTI_AGENT_1_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_1_OPENAI_MODEL=gpt-4o
CTI_AGENT_1_OPENAI_API_KEY=sk-your-openai-key
CTI_AGENT_1_MAX_TURNS=15

# Instance 2: Code review with GPT-3.5
CTI_AGENT_2_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_2_FIRST_PROMPT=Review this function for bugs and suggest improvements: def quicksort(arr): ...
CTI_AGENT_2_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_2_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_2_OPENAI_API_KEY=sk-your-openai-key
CTI_AGENT_2_MAX_TURNS=5

# Instance 3: Local LLM via Ollama
CTI_AGENT_3_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_3_FIRST_PROMPT=Explain quantum computing in simple terms
CTI_AGENT_3_OPENAI_BASE_URL=http://localhost:11434/v1
CTI_AGENT_3_OPENAI_MODEL=llama3.2
CTI_AGENT_3_OPENAI_API_KEY=fake-key
CTI_AGENT_3_MAX_TURNS=8
```

### Multi-Instance (Named)

Use descriptive names for better organization:

```bash
# Main conversation
CTI_AGENT_MAIN_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_MAIN_FIRST_PROMPT=Let's collaborate on building a web scraper
CTI_AGENT_MAIN_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_MAIN_OPENAI_MODEL=gpt-4o-mini
CTI_AGENT_MAIN_OPENAI_API_KEY=sk-your-key
CTI_AGENT_MAIN_MAX_TURNS=20

# Debate simulation
CTI_AGENT_DEBATE_REDIS_URL=redis://127.0.0.1:6380  # Different Redis DB
CTI_AGENT_DEBATE_FIRST_PROMPT=Debate: AI safety regulations - necessary or harmful? You argue for regulation.
CTI_AGENT_DEBATE_OPENAI_BASE_URL=https://openrouter.ai/api/v1
CTI_AGENT_DEBATE_OPENAI_MODEL=anthropic/claude-3.5-sonnet
CTI_AGENT_DEBATE_OPENAI_API_KEY=sk-or-v1-your-key
CTI_AGENT_DEBATE_MAX_TURNS=12

# Testing environment
CTI_AGENT_TEST_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_TEST_FIRST_PROMPT=Write unit tests for a binary search implementation
CTI_AGENT_TEST_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_TEST_OPENAI_MODEL=gpt-4o-mini
CTI_AGENT_TEST_OPENAI_API_KEY=sk-your-key
CTI_AGENT_TEST_MAX_TURNS=6
```

## Redis Strategy

### Same Redis Instance (Default)

All instances can share one Redis server with different session IDs:

```bash
CTI_AGENT_1_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_2_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_3_REDIS_URL=redis://127.0.0.1:6379
```

Redis keys are automatically namespaced:
- Instance 1: `agent:1:SESSION_ID:input`
- Instance 2: `agent:2:SESSION_ID:input`
- Instance 3: `agent:3:SESSION_ID:input`

### Separate Redis Databases

Use different Redis databases for isolation:

```bash
CTI_AGENT_1_REDIS_URL=redis://127.0.0.1:6379/0  # DB 0
CTI_AGENT_2_REDIS_URL=redis://127.0.0.1:6379/1  # DB 1
CTI_AGENT_3_REDIS_URL=redis://127.0.0.1:6379/2  # DB 2
```

### Separate Redis Servers

Run multiple Redis instances on different ports:

```bash
# Terminal 1
redis-server --port 6379

# Terminal 2
redis-server --port 6380

# Terminal 3
redis-server --port 6381
```

Configuration:
```bash
CTI_AGENT_1_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_2_REDIS_URL=redis://127.0.0.1:6380
CTI_AGENT_3_REDIS_URL=redis://127.0.0.1:6381
```

## Monitoring Multiple Instances

### View All Sessions

```bash
redis-cli KEYS "agent:*"
```

Output:
```
1) "agent:1:abc123:input"
2) "agent:1:abc123:turns"
3) "agent:2:def456:input"
4) "agent:2:def456:turns"
5) "agent:main:ghi789:input"
6) "agent:main:ghi789:turns"
```

### Monitor Specific Instance

```bash
# Instance 1
redis-cli KEYS "agent:1:*"

# Named instance "debate"
redis-cli KEYS "agent:debate:*"
```

### Check Turn Counts

```bash
# Instance 1
redis-cli GET "agent:1:SESSION_ID:turns"

# Instance 2
redis-cli GET "agent:2:SESSION_ID:turns"
```

### View Logs by Instance

```bash
# All logs
/claude-to-im logs 200

# Filter by instance
/claude-to-im logs 200 | grep "agent:1"
/claude-to-im logs 200 | grep "agent:debate"
```

## Use Cases

### 1. Model Comparison

Compare different OpenAI models on the same prompt:

```bash
CTI_AGENT_GPT35_FIRST_PROMPT=Explain neural networks in 3 sentences
CTI_AGENT_GPT35_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_GPT35_MAX_TURNS=3

CTI_AGENT_GPT4_FIRST_PROMPT=Explain neural networks in 3 sentences
CTI_AGENT_GPT4_OPENAI_MODEL=gpt-4o
CTI_AGENT_GPT4_MAX_TURNS=3

CTI_AGENT_GPT4MINI_FIRST_PROMPT=Explain neural networks in 3 sentences
CTI_AGENT_GPT4MINI_OPENAI_MODEL=gpt-4o-mini
CTI_AGENT_GPT4MINI_MAX_TURNS=3
```

### 2. Parallel Debates

Run multiple debate simulations simultaneously:

```bash
# Climate change debate
CTI_AGENT_CLIMATE_FIRST_PROMPT=Debate: Climate action vs economic growth. You prioritize climate.
CTI_AGENT_CLIMATE_MAX_TURNS=10

# AI ethics debate
CTI_AGENT_ETHICS_FIRST_PROMPT=Debate: AI rights and personhood. You argue AIs deserve rights.
CTI_AGENT_ETHICS_MAX_TURNS=10

# Space exploration debate
CTI_AGENT_SPACE_FIRST_PROMPT=Debate: Mars colonization vs Earth problems. You argue for Mars.
CTI_AGENT_SPACE_MAX_TURNS=10
```

### 3. Development Workflow

Different instances for different stages:

```bash
# Brainstorming
CTI_AGENT_BRAINSTORM_FIRST_PROMPT=Help me brainstorm features for a task manager app
CTI_AGENT_BRAINSTORM_MAX_TURNS=8

# Architecture
CTI_AGENT_ARCH_FIRST_PROMPT=Design the system architecture for the task manager
CTI_AGENT_ARCH_MAX_TURNS=6

# Code review
CTI_AGENT_REVIEW_FIRST_PROMPT=Review this implementation and suggest improvements
CTI_AGENT_REVIEW_MAX_TURNS=4
```

### 4. A/B Testing

Test prompt variations:

```bash
# Version A - Direct
CTI_AGENT_A_FIRST_PROMPT=Write a Python function to calculate fibonacci numbers
CTI_AGENT_A_MAX_TURNS=3

# Version B - Step-by-step
CTI_AGENT_B_FIRST_PROMPT=Let's write a fibonacci function step by step. First, define the base cases.
CTI_AGENT_B_MAX_TURNS=3
```

## Performance Considerations

### Resource Usage

Each instance consumes:
- ~50MB RAM baseline
- Redis memory: <1KB per message
- Network: API calls per turn
- CPU: Minimal (mostly I/O waiting)

**Recommended**: 5-10 concurrent instances on typical hardware

### Cost Optimization

```bash
# Use cheaper models for testing
CTI_AGENT_TEST_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_TEST_MAX_TURNS=3

# Use expensive models for production
CTI_AGENT_PROD_OPENAI_MODEL=gpt-4o
CTI_AGENT_PROD_MAX_TURNS=10
```

### Rate Limiting

Stagger start times to avoid rate limits:

```bash
# Start instance 1
/claude-to-im start

# Wait 5 seconds, then start instance 2
# (Manual restart or use separate config files)
```

## Troubleshooting

### Instance Not Starting

Check logs for specific instance:
```bash
/claude-to-im logs 100 | grep "agent:YOUR_INSTANCE_ID"
```

Common issues:
- Missing API key: `CTI_AGENT_X_OPENAI_API_KEY` not set
- Invalid Redis URL: Check connection string
- Name conflict: Ensure instance IDs are unique

### Mixed Redis Data

Clear specific instance:
```bash
# Instance 1
redis-cli DEL "agent:1:*"

# Named instance
redis-cli DEL "agent:debate:*"
```

### Memory Issues

Monitor Redis memory:
```bash
redis-cli INFO memory
```

Set maxmemory policy:
```bash
redis-cli CONFIG SET maxmemory 100mb
redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

## Best Practices

1. **Use descriptive names** for production instances
2. **Use numbers** for testing/temporary instances
3. **Separate Redis DBs** for completely isolated experiments
4. **Set reasonable MAX_TURNS** to prevent runaway costs
5. **Monitor Redis memory** usage regularly
6. **Clean up** completed sessions periodically
7. **Document** each instance's purpose in comments

## Example: Full Multi-Instance Setup

```bash
# ~/.claude-to-im/config.env

# ── Runtime ──
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=agent
CTI_DEFAULT_WORKDIR=/tmp
CTI_DEFAULT_MODE=code
CTI_AUTO_APPROVE=true

# ── Instance 1: GPT-4 Debate ──
CTI_AGENT_1_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_1_FIRST_PROMPT=Debate: Universal Basic Income. You argue in favor.
CTI_AGENT_1_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_1_OPENAI_MODEL=gpt-4o
CTI_AGENT_1_OPENAI_API_KEY=sk-your-key
CTI_AGENT_1_MAX_TURNS=12

# ── Instance 2: GPT-3.5 Code Review ──
CTI_AGENT_2_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_2_FIRST_PROMPT=Review this React component for performance issues
CTI_AGENT_2_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_2_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_2_OPENAI_API_KEY=sk-your-key
CTI_AGENT_2_MAX_TURNS=5

# ── Instance 3: Local Llama ──
CTI_AGENT_3_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_3_FIRST_PROMPT=Explain machine learning to a 10-year-old
CTI_AGENT_3_OPENAI_BASE_URL=http://localhost:11434/v1
CTI_AGENT_3_OPENAI_MODEL=llama3.2
CTI_AGENT_3_OPENAI_API_KEY=fake-key
CTI_AGENT_3_MAX_TURNS=8

# ── Named Instance: Production ──
CTI_AGENT_PROD_REDIS_URL=redis://127.0.0.1:6379/1
CTI_AGENT_PROD_FIRST_PROMPT=Let's build a recommendation system
CTI_AGENT_PROD_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_PROD_OPENAI_MODEL=gpt-4o
CTI_AGENT_PROD_OPENAI_API_KEY=sk-your-key
CTI_AGENT_PROD_MAX_TURNS=20
```

Start the bridge:
```bash
/claude-to-im start
```

All instances will start automatically and run concurrently!

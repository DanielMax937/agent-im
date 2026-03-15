# Agent Multi-Instance Quick Reference

## Single Instance (Backward Compatible)

```bash
CTI_AGENT_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_FIRST_PROMPT=Hello!
CTI_AGENT_OPENAI_MODEL=gpt-4o-mini
CTI_AGENT_OPENAI_API_KEY=sk-xxx
CTI_AGENT_MAX_TURNS=10
```

## Multiple Instances

### Numbered (1-10)

```bash
CTI_AGENT_1_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_1_FIRST_PROMPT=Debate AGI feasibility
CTI_AGENT_1_OPENAI_MODEL=gpt-4o
CTI_AGENT_1_OPENAI_API_KEY=sk-xxx
CTI_AGENT_1_MAX_TURNS=15

CTI_AGENT_2_REDIS_URL=redis://127.0.0.1:6379
CTI_AGENT_2_FIRST_PROMPT=Review this code
CTI_AGENT_2_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_2_OPENAI_API_KEY=sk-xxx
CTI_AGENT_2_MAX_TURNS=5
```

### Named

```bash
CTI_AGENT_MAIN_OPENAI_MODEL=gpt-4o
CTI_AGENT_MAIN_OPENAI_API_KEY=sk-xxx

CTI_AGENT_DEBATE_OPENAI_MODEL=gpt-4o
CTI_AGENT_DEBATE_OPENAI_API_KEY=sk-xxx

CTI_AGENT_TEST_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_TEST_OPENAI_API_KEY=sk-xxx
```

## Redis Keys

```bash
# List all instances
redis-cli KEYS "agent:*"

# Instance 1
redis-cli KEYS "agent:1:*"

# Named instance
redis-cli KEYS "agent:main:*"

# Check turns
redis-cli GET "agent:1:SESSION_ID:turns"
```

## Monitoring

```bash
# View all logs
/claude-to-im logs 200

# Filter by instance
/claude-to-im logs 200 | grep "agent:1"
/claude-to-im logs 200 | grep "agent:main"
```

## Common Patterns

### Model Comparison
```bash
CTI_AGENT_1_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_2_OPENAI_MODEL=gpt-4o
CTI_AGENT_3_OPENAI_MODEL=gpt-4o-mini
# Same prompt, different models
```

### Separate Redis DBs
```bash
CTI_AGENT_1_REDIS_URL=redis://127.0.0.1:6379/0
CTI_AGENT_2_REDIS_URL=redis://127.0.0.1:6379/1
CTI_AGENT_3_REDIS_URL=redis://127.0.0.1:6379/2
```

### Different Providers
```bash
# OpenAI
CTI_AGENT_1_OPENAI_BASE_URL=https://api.openai.com/v1
CTI_AGENT_1_OPENAI_MODEL=gpt-4o

# OpenRouter
CTI_AGENT_2_OPENAI_BASE_URL=https://openrouter.ai/api/v1
CTI_AGENT_2_OPENAI_MODEL=anthropic/claude-3.5-sonnet

# Ollama (local)
CTI_AGENT_3_OPENAI_BASE_URL=http://localhost:11434/v1
CTI_AGENT_3_OPENAI_MODEL=llama3.2
CTI_AGENT_3_OPENAI_API_KEY=fake-key
```

## Troubleshooting

### Instance not starting
```bash
# Check logs
/claude-to-im logs | grep "agent:YOUR_ID"

# Verify API key is set
echo $CTI_AGENT_1_OPENAI_API_KEY
```

### Clear instance data
```bash
# Single instance
redis-cli DEL "agent:1:*"

# All agents
redis-cli KEYS "agent:*" | xargs redis-cli DEL
```

### Memory check
```bash
redis-cli INFO memory
```

## Limits

- Numbered instances: 1-10
- Named instances: unlimited
- Concurrent instances: 5-10 recommended
- Memory per instance: ~50MB

## Full Example

```bash
# ~/.claude-to-im/config.env
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=agent
CTI_AUTO_APPROVE=true

# Debate: AGI
CTI_AGENT_1_FIRST_PROMPT=Debate: Is AGI achievable with current architectures?
CTI_AGENT_1_OPENAI_MODEL=gpt-4o
CTI_AGENT_1_OPENAI_API_KEY=sk-xxx
CTI_AGENT_1_MAX_TURNS=12

# Code Review
CTI_AGENT_2_FIRST_PROMPT=Review this React component for bugs
CTI_AGENT_2_OPENAI_MODEL=gpt-3.5-turbo
CTI_AGENT_2_OPENAI_API_KEY=sk-xxx
CTI_AGENT_2_MAX_TURNS=5

# Local Model
CTI_AGENT_3_FIRST_PROMPT=Explain quantum computing simply
CTI_AGENT_3_OPENAI_BASE_URL=http://localhost:11434/v1
CTI_AGENT_3_OPENAI_MODEL=llama3.2
CTI_AGENT_3_OPENAI_API_KEY=fake
CTI_AGENT_3_MAX_TURNS=8
```

Start:
```bash
/claude-to-im start
```

All 3 instances run concurrently!

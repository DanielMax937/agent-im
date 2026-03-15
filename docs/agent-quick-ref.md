# Agent Channel Quick Reference

## Minimal Configuration

```bash
# ~/.claude-to-im/config.env
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=agent
CTI_DEFAULT_WORKDIR=/tmp
CTI_DEFAULT_MODE=code

# Agent configuration
CTI_AGENT_OPENAI_API_KEY=sk-your-openai-api-key
```

## Start

```bash
# Start Redis (if not running)
redis-server

# Start bridge
/claude-to-im start

# Monitor
/claude-to-im logs
```

## Configuration Options

```bash
# Conversation
CTI_AGENT_FIRST_PROMPT="Your opening message"    # Default: "Hello, how are you?"
CTI_AGENT_MAX_TURNS=20                           # Default: 10

# OpenAI API
CTI_AGENT_OPENAI_API_KEY=sk-xxx                  # Required
CTI_AGENT_OPENAI_MODEL=gpt-4o-mini               # Default: gpt-4o-mini
CTI_AGENT_OPENAI_BASE_URL=https://api.openai.com/v1  # Default

# Redis
CTI_AGENT_REDIS_URL=redis://127.0.0.1:6379       # Default
```

## Redis Commands

```bash
# Connect
redis-cli

# Find session
KEYS agent:*

# Check turns
GET agent:SESSION_ID:turns

# View queue
LRANGE agent:SESSION_ID:input 0 -1

# Clear queue
DEL agent:SESSION_ID:input
DEL agent:SESSION_ID:turns
```

## Alternative Providers

### OpenRouter
```bash
CTI_AGENT_OPENAI_BASE_URL=https://openrouter.ai/api/v1
CTI_AGENT_OPENAI_MODEL=anthropic/claude-3.5-sonnet
CTI_AGENT_OPENAI_API_KEY=sk-or-v1-xxx
```

### Ollama (Local)
```bash
CTI_AGENT_OPENAI_BASE_URL=http://localhost:11434/v1
CTI_AGENT_OPENAI_MODEL=llama3.2
CTI_AGENT_OPENAI_API_KEY=fake-key
```

### Azure OpenAI
```bash
CTI_AGENT_OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment
CTI_AGENT_OPENAI_API_KEY=your-azure-key
```

## Common Issues

### Redis not found
```bash
brew install redis      # macOS
apt install redis       # Linux
docker run -d -p 6379:6379 redis  # Docker
```

### API key invalid
- Check OpenAI dashboard for key status
- Verify billing is active
- Ensure key has correct permissions

### Agent stops immediately
- Check `CTI_AGENT_MAX_TURNS` value
- Review logs: `/claude-to-im logs`
- Verify Redis is accessible

### No responses
- Ensure `CTI_AUTO_APPROVE=true` (agent needs tool permissions)
- Check Claude CLI is authenticated: `claude auth login`
- Verify OpenAI API key is valid

## Example Prompts

### Code Review
```bash
CTI_AGENT_FIRST_PROMPT="Review this Python function: def fib(n): return fib(n-1) + fib(n-2) if n > 1 else n"
```

### Debate
```bash
CTI_AGENT_FIRST_PROMPT="Let's debate: Is AGI achievable with current deep learning architectures? I'll argue yes."
```

### Brainstorming
```bash
CTI_AGENT_FIRST_PROMPT="Help me brainstorm 10 startup ideas in the AI + healthcare space."
```

### Creative Writing
```bash
CTI_AGENT_FIRST_PROMPT="Let's write a sci-fi story. You start with the opening paragraph."
```

## Performance Tuning

```bash
# Faster responses (fewer turns)
CTI_AGENT_MAX_TURNS=5
CTI_AGENT_OPENAI_MODEL=gpt-3.5-turbo

# Higher quality (more turns)
CTI_AGENT_MAX_TURNS=20
CTI_AGENT_OPENAI_MODEL=gpt-4o

# Cost optimization
CTI_AGENT_OPENAI_MODEL=gpt-4o-mini
CTI_AGENT_MAX_TURNS=10
```

## Monitoring

```bash
# View all logs
/claude-to-im logs 200

# Filter agent logs
/claude-to-im logs 100 | grep agent

# Check Redis memory
redis-cli INFO memory

# Monitor in real-time
tail -f ~/.claude-to-im/logs/bridge.log
```

## Clean Up

```bash
# Stop bridge
/claude-to-im stop

# Clear Redis data
redis-cli FLUSHDB

# Remove logs
rm -rf ~/.claude-to-im/logs/*
```

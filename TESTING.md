# Testing Guide

This document describes how to run, write, and maintain tests for the agent-im platform.

## Overview

The project uses two test frameworks:

- **Node.js native test runner** for TypeScript/JavaScript unit and integration tests
- **pytest** for Python-based research module tests

## Quick Start

### Run All Tests

```bash
npm test
```

This runs all TypeScript tests with environment variables configured for test isolation.

### Run Specific Test Files

```bash
# Single test file
NODE_OPTIONS='--experimental-sqlite' node --test --import tsx src/__tests__/store.test.ts

# Pattern matching
NODE_OPTIONS='--experimental-sqlite' node --test --import tsx 'src/__tests__/*auto-mode*.test.ts'
```

### Run Python Tests

```bash
# All Python tests
pytest tests/

# Specific test file
pytest tests/test_answer_validation.py

# Verbose output
pytest tests/ -v

# Show print statements
pytest tests/ -s
```

## Test Organization

### TypeScript Tests

Located in `src/__tests__/`, organized by feature:

```
src/__tests__/
├── store.test.ts                     # Data persistence unit tests
├── instance-manager.test.ts          # Agent lifecycle tests
├── board-brainstorm.test.ts          # Kanban workflow unit tests
├── board-brainstorm.e2e.test.ts      # End-to-end workflow tests
├── runtime-provider-auto-approve.test.ts  # Runtime config tests
├── telegram-auto-mode-session-reset.test.ts  # IM bridge tests
├── vercel-cli.integration.test.ts    # External service integration
└── ...
```

**Test types:**
- `*.test.ts` - Unit tests
- `*.e2e.test.ts` - End-to-end tests
- `*.integration.test.ts` - External service integration tests (may require env vars)

### Python Tests

Located in `tests/`, organized by test type:

```
tests/
├── fixtures/
│   └── enterprise_corpus.py         # Shared test data
├── unit/
│   ├── test_citations.py            # Citation validation
│   ├── test_routing.py              # Query routing
│   ├── test_context_gate.py         # Context filtering
│   └── ...
├── test_answer_validation.py        # Answer quality checks
└── test_enterprise_rag.py           # RAG pipeline integration
```

## Writing Tests

### TypeScript Unit Tests

Use Node.js native test runner with `node:test` and `node:assert/strict`:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('MyFeature', () => {
  beforeEach(() => {
    // Setup before each test
  });

  it('should do something', () => {
    const result = myFunction();
    assert.equal(result, 'expected');
  });

  it('should handle edge cases', () => {
    assert.throws(() => {
      myFunction(null);
    }, /Invalid input/);
  });
});
```

**Best practices:**
- Use `describe` for grouping related tests
- Use descriptive test names starting with 'should'
- Clean up resources in `beforeEach` or `afterEach`
- Use `assert.strictEqual` for exact equality checks

### TypeScript E2E Tests

End-to-end tests exercise the full platform API:

```typescript
import { createPlatformApp } from '../platform/app';
import { createTestJsonPlatformStore } from './platform-test-helpers';

describe('Feature E2E', () => {
  it('should complete workflow', async () => {
    const store = createTestJsonPlatformStore();
    const app = createPlatformApp({ store, /* ... */ });
    const server = await startHttpApp(app);
    
    try {
      const res = await fetch(`${server.baseUrl}/api/endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ /* payload */ }),
      });
      
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.sessionId);
    } finally {
      await server.close();
    }
  });
});
```

### Python Tests with pytest

Use pytest fixtures and assertions:

```python
import pytest
from app.core.module import MyClass

@pytest.fixture
def sample_data():
    """Create test data."""
    return {
        "id": "test-1",
        "value": "sample"
    }

def test_basic_functionality(sample_data):
    """Test basic operations."""
    instance = MyClass(sample_data)
    result = instance.process()
    
    assert result is not None
    assert result.status == "success"

def test_error_handling():
    """Test error conditions."""
    with pytest.raises(ValueError, match="Invalid input"):
        MyClass(None)
```

### Integration Tests

Some tests require external services or specific environment variables:

```typescript
// Skip conditionally
const shouldRun = process.env.CTI_TEST_VERCEL_REAL === '1';
const describeReal = shouldRun ? describe : describe.skip;

describeReal('Vercel integration', () => {
  it('should link project', async () => {
    // Test that requires real Vercel CLI
  });
});
```

Run with:
```bash
CTI_TEST_VERCEL_REAL=1 npm test
```

## Test Fixtures

### TypeScript Fixtures

Helper utilities in `src/__tests__/platform-test-helpers.ts`:

```typescript
import { 
  createTestJsonPlatformStore,
  FakeInstanceManager,
  startHttpApp,
  fetchJson
} from './platform-test-helpers';

// Create isolated test store
const store = createTestJsonPlatformStore();

// Mock instance manager
const instanceManager = new FakeInstanceManager(store);

// Start test HTTP server
const server = await startHttpApp(app);
```

### Python Fixtures

Shared test data in `tests/fixtures/`:

```python
from tests.fixtures.enterprise_corpus import get_sample_documents

def test_with_corpus():
    docs = get_sample_documents()
    # Use test documents
```

### Environment-Based Fixtures

The test script sets up isolated environments:

```bash
CTI_HOME=$(mktemp -d)                    # Isolated config directory
CTI_KANBAN_PLATFORM_DIR=$(mktemp -d)     # Isolated platform data
CTI_KANBAN_PLATFORM_DB_FILE=test.db      # Test database file
```

This ensures tests don't interfere with development data.

## Test Scripts

### Kanban Full Flow Test

Comprehensive end-to-end test covering the full delivery pipeline:

```bash
npm run test:kanban:full
```

This runs `scripts/kanban-full-test-runner.mjs`, which:
- Creates test projects, sprints, and tasks
- Runs developer, reviewer, and tester agents
- Validates state transitions and Git operations
- Checks approval flows and notifications

**Requirements:**
- GitHub CLI (`gh`) authenticated
- Self-hosted runner (or GitHub Actions environment)
- Access to test repository

### Shell Integration Tests

Located in `scripts/`:

```bash
# Test Telegram bridge
./scripts/test-telegram.sh

# Test proxy polling
./scripts/test-proxy-poll.sh

# Test OpenAI chat completions
./scripts/openai_chat_completions_test.sh
```

## Coverage Reporting

Currently, no automated coverage reporting is configured.

To add coverage:

**For TypeScript (using c8):**

```bash
npm install --save-dev c8

# Run tests with coverage
npx c8 node --test --import tsx 'src/__tests__/*.test.ts'

# Generate HTML report
npx c8 --reporter=html node --test --import tsx 'src/__tests__/*.test.ts'
```

**For Python (using pytest-cov):**

```bash
pip install pytest-cov

# Run with coverage
pytest tests/ --cov=app --cov-report=html

# View report
open htmlcov/index.html
```

## CI/CD Integration

### Current Status

The project does not currently have CI configuration files (`.github/workflows/`, `.gitlab-ci.yml`, etc.).

### Recommended CI Setup

Example GitHub Actions workflow:

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test-typescript:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '22.5.0'
      - run: npm ci
      - run: npm test

  test-python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.11'
      - run: pip install -r requirements.txt
      - run: pytest tests/ -v
```

### Integration Test Considerations

- **Vercel integration tests** require `CTI_TEST_VERCEL_REAL=1` and Vercel CLI authentication
- **Kanban full tests** require GitHub CLI authentication and self-hosted runner access
- **IM bridge tests** require bot tokens (should be stored as secrets)

Recommended approach:
- Run unit tests on every commit
- Run integration tests on PRs or scheduled nightly builds
- Store credentials in CI secrets

## Common Test Patterns

### Testing Store Operations

```typescript
import { JsonFileStore } from '../store';
import { getCtiHome } from '../config';

beforeEach(() => {
  // Clean data directory for isolation
  fs.rmSync(path.join(getCtiHome(), 'data'), { 
    recursive: true, 
    force: true 
  });
});

it('should persist session', () => {
  const store = new JsonFileStore(new Map());
  const session = store.createSession('test', 'model-1', 'prompt', '/tmp');
  
  const fetched = store.getSession(session.id);
  assert.deepEqual(fetched, session);
});
```

### Testing Workflow Streams

```typescript
it('should stream workflow results', async () => {
  const stream = await workflowService.streamBoardBrainstormChat(input);
  const reader = stream.getReader();
  const chunks: string[] = [];
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  
  assert.ok(chunks.some(c => c.includes('type: "result"')));
});
```

### Testing Async Lock Behavior

```typescript
it('should prevent concurrent access', () => {
  const store = new JsonFileStore(new Map());
  
  assert.ok(store.acquireSessionLock('sess-1', 'lock-a', 'owner-1', 60));
  assert.equal(store.acquireSessionLock('sess-1', 'lock-b', 'owner-2', 60), false);
  
  store.releaseSessionLock('sess-1', 'lock-a');
  assert.ok(store.acquireSessionLock('sess-1', 'lock-b', 'owner-2', 60));
});
```

### Testing Python Validation Logic

```python
def test_validation_scores():
    """Test validation scoring."""
    validator = AnswerValidator()
    
    evidence = [{"content": "Fact A is true."}]
    answer = "Fact A is true [1]."
    
    report = validator.validate(answer, evidence, citations=["1"])
    
    assert report.is_valid
    assert report.grounding_score > 0.8
    assert len(report.issues) == 0
```

## Debugging Tests

### Enable Verbose Output

```bash
# Node tests
NODE_OPTIONS='--experimental-sqlite' node --test --test-reporter=spec --import tsx src/__tests__/store.test.ts

# Python tests
pytest tests/ -vv -s
```

### Run Single Test

```typescript
// Use it.only to focus on one test
it.only('should debug this test', () => {
  // Your test
});
```

```python
# Run specific test function
pytest tests/test_citations.py::TestCitationValidator::test_well_cited_answer -v
```

### Increase Test Timeout

The default timeout is 600000ms (10 minutes). Adjust in package.json:

```json
"test": "node --test --test-timeout=1200000 ..."
```

Or per-test:

```typescript
it('long running test', { timeout: 1200000 }, async () => {
  // Test code
});
```

## Troubleshooting

### Tests Fail with "Cannot find module"

Ensure `tsx` is installed and `--import tsx` is passed to node:

```bash
npm install --save-dev tsx
NODE_OPTIONS='--experimental-sqlite' node --test --import tsx src/__tests__/store.test.ts
```

### SQLite Experimental Warning

The `--experimental-sqlite` flag enables Node's built-in SQLite. This is expected and safe.

### Test Isolation Issues

If tests interfere with each other:
- Check that `CTI_HOME` and `CTI_KANBAN_PLATFORM_DIR` are set to temp directories
- Add `beforeEach` cleanup to remove shared state
- Use `--test-concurrency=1` to run tests serially

### Python Import Errors

Ensure the app module is on PYTHONPATH:

```bash
PYTHONPATH=. pytest tests/
```

Or install in editable mode:

```bash
pip install -e .
```

## Adding New Tests

### Checklist

1. **Choose test type**: unit, integration, or e2e
2. **Create test file** in appropriate directory:
   - TypeScript: `src/__tests__/feature-name.test.ts`
   - Python: `tests/unit/test_feature_name.py` or `tests/test_feature_name.py`
3. **Import framework**: `node:test` for TypeScript, `pytest` for Python
4. **Write descriptive test names**: start with "should" or "test_"
5. **Add fixtures** if needed for shared setup
6. **Clean up resources** in `beforeEach`/`afterEach` or pytest fixtures
7. **Run test** to verify it passes
8. **Run full suite** to ensure no regressions

### Example: Adding a New Feature Test

```typescript
// src/__tests__/new-feature.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newFeature } from '../platform/new-feature';

describe('New Feature', () => {
  beforeEach(() => {
    // Setup
  });

  it('should handle basic case', () => {
    const result = newFeature('input');
    assert.equal(result, 'expected output');
  });

  it('should throw on invalid input', () => {
    assert.throws(() => {
      newFeature(null);
    }, /Invalid input/);
  });
});
```

Run it:
```bash
NODE_OPTIONS='--experimental-sqlite' node --test --import tsx src/__tests__/new-feature.test.ts
```

## Resources

- [Node.js Test Runner Documentation](https://nodejs.org/api/test.html)
- [pytest Documentation](https://docs.pytest.org/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- Project README: [README.md](./README.md)
- Chinese README: [README_CN.md](./README_CN.md)

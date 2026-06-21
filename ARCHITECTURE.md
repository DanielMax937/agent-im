# Agent-IM Architecture

## System Overview

Agent-IM is a task-driven AI delivery platform that orchestrates multiple AI agents across the software development lifecycle, integrating IM platforms, Git workflows, and automated Kanban execution into a unified system.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            External Interfaces                          │
├──────────────────┬──────────────────┬──────────────────┬───────────────┤
│   Web UI         │  IM Platforms    │   Git/SCM        │  AI Runtimes  │
│   (Next.js)      │  (Telegram,      │   (GitHub,       │  (Claude,     │
│                  │   Discord,        │    GitLab)       │   Codex,      │
│                  │   Feishu, QQ)     │                  │   Cursor,     │
│                  │                   │                  │   Copilot)    │
└────────┬─────────┴────────┬──────────┴─────────┬────────┴──────┬────────┘
         │                  │                    │               │
         v                  v                    v               v
┌─────────────────────────────────────────────────────────────────────────┐
│                         Platform HTTP Layer                             │
│                      (src/platform/app.ts)                              │
│   - Project/Sprint/Task APIs                                            │
│   - Workflow transition endpoints                                       │
│   - Instance management                                                 │
│   - Approval routing                                                    │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         │                                   │
         v                                   v
┌──────────────────────┐          ┌──────────────────────┐
│  Workflow Service    │          │  IM Bridge Manager   │
│  (State Machine)     │          │  (Message Router)    │
│                      │          │                      │
│  - Sprint lifecycle  │          │  - Channel adapters  │
│  - Task transitions  │          │  - Session binding   │
│  - Dependency mgmt   │          │  - Permission flow   │
│  - Auto-advance      │          │  - Delivery layer    │
└──────┬───────────────┘          └──────────┬───────────┘
       │                                     │
       v                                     v
┌──────────────────────┐          ┌──────────────────────┐
│  Instance Manager    │          │  Conversation Engine │
│  (Agent Lifecycle)   │          │  (Stream Consumer)   │
│                      │          │                      │
│  - Task queue poller │          │  - LLM interaction   │
│  - Runner spawning   │          │  - Tool approval     │
│  - Approval routing  │          │  - Result parsing    │
└──────┬───────────────┘          └──────────┬───────────┘
       │                                     │
       └────────────┬────────────────────────┘
                    │
                    v
┌─────────────────────────────────────────────────────────────────────────┐
│                         Runtime Provider Layer                          │
│                      (src/runtime-provider.ts)                          │
│   - Unified LLMProvider interface                                       │
│   - Claude/Codex/Cursor/Copilot adapters                                │
│   - SSE stream normalization                                            │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │
                           v
┌─────────────────────────────────────────────────────────────────────────┐
│                          Persistence Layer                              │
│                                                                         │
│  ┌───────────────────────┐        ┌────────────────────────┐          │
│  │  Bridge Store         │        │  Platform Store        │          │
│  │  (JSON files)         │        │  (SQLite)              │          │
│  │                       │        │                        │          │
│  │  - IM sessions        │        │  - Projects            │          │
│  │  - Bindings           │        │  - Sprints             │          │
│  │  - Messages           │        │  - Task sessions       │          │
│  │  - Permissions        │        │  - Agent instances     │          │
│  │  - Offsets            │        │  - Task queues         │          │
│  │  - Audit logs         │        │  - Approvals           │          │
│  └───────────────────────┘        └────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Descriptions

### 1. Web UI Layer (Next.js)
- **Location**: `src/app/`
- **Role**: Human interface for platform configuration, project management, and workflow monitoring
- **Key Pages**:
  - `/admin`: Bridge and runtime configuration
  - `/projects`: Project and repository management
  - `/board`: Kanban board with task visualization
  - `/board/monitor`: Live agent activity monitoring

### 2. IM Bridge Subsystem
- **Location**: `src/lib/bridge/`, `src/main.ts`
- **Role**: Bidirectional communication between IM platforms and AI runtimes
- **Components**:
  - **Bridge Manager** (`bridge-manager.ts`): Orchestrates adapters and routes messages
  - **Channel Adapters** (`adapters/`): Platform-specific IM integrations (Telegram, Discord, Feishu, QQ, Redis)
  - **Channel Router** (`channel-router.ts`): Maps IM chats to persistent sessions
  - **Conversation Engine** (`conversation-engine.ts`): LLM stream processing and conversation state
  - **Permission Broker** (`permission-broker.ts`): Real-time tool approval flow
  - **Delivery Layer** (`delivery-layer.ts`): Reliable message delivery with chunking, rate limiting, retry
- **Data Model**:
  - Channel binding: IM chat → session mapping
  - Session messages: persistent conversation history
  - Permission links: approval request tracking
  - Adapter offsets: message deduplication

### 3. Platform Workflow Engine
- **Location**: `src/platform/workflow-service.ts`
- **Role**: Kanban state machine and task lifecycle orchestration
- **Workflow States**:
  ```
  todo → pending_start → in_progress → pre_testing → testing
                              ↓                         ↓
                         [failure loop]           review
                              ↑                         ↓
                              └───────────┬─────────────┘
                                          ↓
                              regression_testing → pending_uat → 
                              pending_release → closing → closed
  ```
- **Key Operations**:
  - `startSprint()`: Create sprint branch
  - `assignTask()`: Create task branch/worktree, start developer agent
  - `submitTaskForReview()`: Commit, push, open PR, start reviewer agent
  - `mergeApprovedPullRequestAndStartRegression()`: Merge PR, start regression testing
  - `handleTestFailure()`: Route failures back to development lane
  - `closeTask()`: Finalize and cleanup
- **Auto-advance**: Parses agent output for workflow directives:
  - `KANBAN_ACTION:SUBMIT_REVIEW`
  - `KANBAN_ACTION:START_TESTING`
  - `KANBAN_ACTION:APPROVE_MERGE`
  - `KANBAN_ACTION:REJECT_REVIEW`
  - `KANBAN_ACTION:CLOSE`

### 4. Instance Manager
- **Location**: `src/platform/instance-manager.ts`
- **Role**: Agent lifecycle management and queue-driven execution
- **Architecture**:
  ```
  InstanceManager
  ├── TaskAgentRunner (per active instance)
  │   ├── Queue poller (drains task message queue)
  │   ├── Provider interaction (via Runtime Provider Layer)
  │   ├── Conversation persistence
  │   └── Approval resolution
  └── Reconciliation (restart recovery)
  ```
- **Execution Model**:
  1. Poll task queue for new messages
  2. Send prompt to assigned runtime provider
  3. Consume LLM stream (status, text, tool calls, result)
  4. Persist assistant response to conversation history
  5. Invoke workflow auto-advance if applicable
  6. Sleep and repeat
- **Timeout & Retry**:
  - Stream timeout: 5 minutes default, 3 retries
  - Runtime error: 2 retries
  - Configurable via `CTI_KANBAN_STREAM_TIMEOUT_MS`, `CTI_KANBAN_STREAM_TIMEOUT_RETRIES`, `CTI_KANBAN_RUNTIME_ERROR_RETRIES`

### 5. Runtime Provider Abstraction
- **Location**: `src/runtime-provider.ts`, `src/{llm,codex,cursor,copilot}-provider.ts`
- **Role**: Unified interface to heterogeneous AI runtimes
- **Interface**: `LLMProvider`
  - `streamChat(prompt, options)`: Returns SSE-like stream
  - `resumeSession(sessionId)`: Continue existing conversation
- **Implementations**:
  - **Claude** (`llm-provider.ts`): Anthropic Agent SDK
  - **Codex** (`codex-provider.ts`): OpenAI Codex SDK
  - **Cursor** (`cursor-provider.ts`): Cursor CLI (`agent` command)
  - **Copilot** (`copilot-provider.ts`): GitHub Copilot CLI
- **Stream Normalization**:
  - All providers emit: `status`, `text`, `tool_use`, `permission_request`, `result`, `error`
  - Session isolation: guards against cross-runtime session leakage

### 6. Git Service & SCM Abstraction
- **Location**: `src/platform/git-service.ts`, `src/platform/scm-client.ts`
- **Role**: Git operations and PR management
- **Capabilities**:
  - Branch creation (sprint, task)
  - Worktree management (default mode)
  - Commit and push automation
  - PR creation and merge (GitHub, GitLab)
  - Conflict detection
- **Branch Strategy**:
  - Base branch (e.g., `main`)
  - Sprint branch: `sprint/<name>`
  - Task branch: `task/<taskId>-<slug>`
  - Worktrees: `.git/worktrees/<taskId>`

### 7. Storage Layer

#### Platform Store (SQLite)
- **Location**: `src/platform/json-platform-store.ts`
- **Default Path**: `<cwd>/data/platform/platform.db`
- **Schema**:
  - **Projects**: Repository metadata, branch strategy, runner mappings
  - **Sprints**: Integration branches, status, task queues
  - **Task Sessions**: Workflow state, branch info, conversation history, queue keys
  - **Agent Instances**: Runtime, working directory, status, generation state
  - **Task Queues**: Pending prompts per task
  - **Approvals**: Tool permission requests
  - **Monitor Turns**: Agent activity log
- **Behavior**:
  - In-memory maps backed by SQLite writes
  - Legacy JSON migration support
  - Transactional updates

#### Bridge Store (JSON Files)
- **Location**: `src/store.ts`
- **Default Path**: `$CTI_HOME/data/` (typically `~/.claude-to-im/<bot>/data/`)
- **Files**:
  - `sessions.json`: Bridge session metadata
  - `bindings.json`: IM chat → session mappings
  - `messages/<sessionId>.json`: Per-session conversation history
  - `permissions.json`: Permission link records
  - `offsets.json`: Adapter message offsets (dedup watermarks)
  - `audit/`: Audit logs
- **Locking**: Session-level locks prevent concurrent processing

## Data Flow

### 1. Task Assignment Flow
```
User creates task (Web UI / API)
         ↓
WorkflowService.assignTask()
         ↓
Create task branch/worktree (GitService)
         ↓
Assign runner (resolve from project config)
         ↓
Create agent instance (InstanceManager)
         ↓
Enqueue kickoff prompt (build from role template)
         ↓
TaskAgentRunner starts polling
         ↓
Runtime provider streams response
         ↓
Parse assistant output for workflow actions
         ↓
Auto-advance to next state if directive found
```

### 2. IM Message Flow
```
User sends IM message (Telegram, Discord, etc.)
         ↓
Channel adapter receives inbound message
         ↓
Bridge Manager dispatches to handleMessage()
         ↓
Acquire per-session lock (serialize same-session)
         ↓
Channel Router resolves IM chat → binding → session
         ↓
Conversation Engine sends prompt to LLM provider
         ↓
Stream consumed server-side:
  - text → accumulate response
  - permission_request → forward to Permission Broker
  - result → capture session ID
         ↓
Response persisted to bridge store
         ↓
Delivery Layer renders for platform (HTML, markdown, cards)
         ↓
Adapter sends via IM API
```

### 3. Tool Approval Flow
```
LLM stream emits permission_request (stream blocks)
         ↓
Permission Broker formats interactive message
         ↓
Delivery Layer sends to IM with inline buttons
         ↓
Store PermissionLink (chat + message ID)
         ↓
User clicks approve/deny button
         ↓
Adapter receives callback as InboundMessage
         ↓
Bridge Manager routes to Permission Broker
         ↓
Validate origin (chat + message match)
         ↓
Atomically claim and resolve via PermissionGateway
         ↓
Stream unblocks, execution continues
```

### 4. Review & Test Iteration Loop
```
Developer agent outputs: KANBAN_ACTION:SUBMIT_REVIEW
         ↓
WorkflowService.submitTaskForReview()
         ↓
Git: commit, push, open PR
         ↓
State → review, start reviewer agent
         ↓
Reviewer agent evaluates changes
         ↓
[Pass] → KANBAN_ACTION:APPROVE_MERGE
  ↓         ↓
  │    Merge PR to sprint branch
  │         ↓
  │    State → regression_testing
  │         ↓
  │    Start tester agent on merged branch
  │         ↓
  │    [Pass] → KANBAN_ACTION:CLOSE
  │         ↓
  │    Task closed
  │
[Fail] → KANBAN_ACTION:REJECT_REVIEW
         ↓
    State → in_progress (rework)
         ↓
    Enqueue failure feedback to developer agent
         ↓
    [Loop continues until pass]
```

## Iteration Loop Mechanics

### Queue-Driven Execution
The platform uses a **task-specific message queue** model instead of a global event bus:

1. **Queue Creation**: Each task gets a unique message queue key on creation
2. **Message Enqueuing**: Workflow operations enqueue prompts:
   - Kickoff prompt (on assignment)
   - System check (after no-op turn)
   - Failure feedback (after test failure)
   - Verification prompt (after review)
3. **Polling**: `TaskAgentRunner` continuously polls its queue (default 500ms interval)
4. **Processing**: Each message becomes a prompt to the runtime provider
5. **Persistence**: Assistant response saved to task conversation history
6. **Auto-advance**: Workflow parser checks output for directives

### Bounded Confirmation Loop
To prevent infinite retry cycles, the platform implements a bounded confirmation loop:

- **Max iterations**: `CTI_KANBAN_CONFIRMATION_MAX_LOOPS` (default: 10)
- **Trigger**: When agent output doesn't advance workflow state
- **Action**: Enqueue `system_check` prompt asking agent to self-verify or submit
- **Exit**: Loop terminates after max iterations, requires human intervention

### Auto Mode (Telegram + Redis)
For autonomous operation, the platform supports a **master/slave runner** pattern:

- **User message** → forwarded to **slave runner** (execution)
- **Slave completion** → report sent to **master runner** (verification)
- **Master review** → synthesizes verdict, routes next action
- **Session reset**: Each new task starts fresh master/slave sessions to avoid context contamination

### Compensation & Rework
Failed testing triggers automatic compensation:

1. Tester agent outputs: `KANBAN_ACTION:FAIL_TESTING`
2. Workflow transitions: `testing` → `in_progress`
3. Failure payload (test logs, errors) enqueued to developer agent
4. Developer agent receives structured failure context
5. Rework cycle begins with full failure visibility

## Safety Mechanisms

### 1. Session Isolation
- **Per-session locking**: Prevents concurrent processing of same IM chat
- **Cross-runtime guards**: Detects and rejects invalid session ID reuse (e.g., Claude session ID passed to Cursor)
- **Binding invalidation**: Recreates sessions when runner backend changes

### 2. Approval & Permission Control
- **Explicit approval**: Tool usage requires user confirmation via IM buttons
- **Auto-approve mode**: Configurable per runner for trusted workflows
- **Origin validation**: Approval callbacks validated against stored PermissionLink (chat + message ID match)
- **Deduplication**: Same permission request cannot be resolved twice

### 3. State Machine Constraints
- **Allowed transitions**: Workflow enforces valid state transitions
- **Dependency blocking**: Tasks cannot start until upstream dependencies reach `pending_release` or `closed`
- **Transient states**: `closing` state prevents premature closure during async checks
- **Blocked state**: Explicitly stops agent execution, requires manual unblock

### 4. Git Safety
- **Worktree isolation**: Default execution in isolated worktrees prevents branch conflicts
- **Commit validation**: Pre-push checks for uncommitted changes
- **Merge conflict detection**: SCM client surfaces merge conflicts as errors
- **Branch cleanup**: Worktrees and branches removed on task closure

### 5. Timeout & Error Handling
- **Stream timeout**: 5-minute default with 3 retries prevents indefinite hangs
- **Runtime error retry**: 2 automatic retries for transient failures
- **Graceful degradation**: Streaming preview failures don't block final delivery
- **Abort handling**: Timeout/stop properly aborts Cursor sessions

### 6. Audit & Monitoring
- **Bridge audit logs**: All IM interactions logged with timestamps
- **Platform monitor turns**: Agent activity recorded with tool usage, duration, status
- **Conversation history**: Complete task conversation preserved
- **Runtime status files**: Bridge daemon writes PID and status for health checks

### 7. Data Integrity
- **Offset acknowledgement**: IM adapter offsets committed only after successful processing (prevents message loss on crash)
- **SQLite transactions**: Platform store updates are transactional
- **Session message append**: Bridge store appends messages atomically
- **Queue deduplication**: Task queues use dedup keys to prevent double-enqueue

### 8. Restart Resilience
- **Instance reconciliation**: `InstanceManager.reconcile()` restores running agents after restart
- **Resume from checkpoint**: Workflow service resumes in-progress tasks
- **Sprint FIFO recovery**: `pending_start` tasks re-queued in original order
- **Dangling cleanup**: Orphaned worktrees and branches detected and cleaned

## Extension Points

### 1. New IM Platform Integration
**Location**: `src/lib/bridge/adapters/`

Add a new platform by implementing `ChannelAdapter` interface:

```typescript
export class CustomAdapter extends BaseChannelAdapter {
  async start(): Promise<void> { /* polling/webhook setup */ }
  async consumeOne(): Promise<boolean> { /* fetch one message */ }
  async send(chatId: string, text: string): Promise<void> { /* send message */ }
  async sendPermissionRequest(chatId, request): Promise<string> { /* interactive approval */ }
  // ... other methods
}
```

Register in `src/lib/bridge/bridge-manager.ts`:
```typescript
this.adapters.set('custom', new CustomAdapter(this.context));
```

### 2. New AI Runtime Provider
**Location**: `src/runtime-provider.ts`

Implement `LLMProvider` interface:

```typescript
class CustomProvider implements LLMProvider {
  async streamChat(prompt: string, options: StreamChatOptions): AsyncIterable<StreamEvent> {
    // Yield: { type: 'status' | 'text' | 'tool_use' | 'permission_request' | 'result' | 'error', ... }
  }
  
  async resumeSession(sessionId: string): Promise<void> { /* restore conversation */ }
}
```

Add to `resolveProvider()` in `src/runtime-provider.ts`:
```typescript
case 'custom':
  return new CustomProvider(/* deps */);
```

Update `AgentRuntime` type in `src/platform/types.ts`:
```typescript
export type AgentRuntime = 'claude' | 'codex' | 'cursor' | 'copilot' | 'custom';
```

### 3. New Workflow State
**Location**: `src/platform/workflow-service.ts`

1. Add state to `TaskWorkflowState` type in `src/platform/types.ts`
2. Update `ALLOWED_TRANSITIONS` map:
   ```typescript
   const ALLOWED_TRANSITIONS: Record<TaskWorkflowState, TaskWorkflowState[]> = {
     // ...
     custom_state: ['next_state_a', 'next_state_b'],
   };
   ```
3. Update `roleForActiveWorkflowState()` if state requires agent:
   ```typescript
   case 'custom_state':
     return 'custom_role';
   ```
4. Add transition method in `WorkflowService`:
   ```typescript
   async transitionToCustomState(taskSessionId: string): Promise<void> {
     // Validate, update state, enqueue prompts, start/stop instances
   }
   ```

### 4. New Agent Role
**Location**: `src/platform/prompts/`, `src/platform/kanban-agents.ts`

1. Add role to `AgentRole` type in `src/platform/types.ts`
2. Create prompt template in `src/platform/prompts/`:
   ```typescript
   export const CUSTOM_ROLE_PROMPT = `...`;
   ```
3. Update `buildRolePrompt()` in `src/platform/prompts/index.ts`
4. Define agent skills in `src/platform/kanban-agents.ts`:
   ```typescript
   export function resolveKanbanAgent(role: AgentRole, ...): KanbanAgentDescriptor {
     // ...
     case 'custom_role':
       return { kind: 'custom_agent', systemPrompt: CUSTOM_ROLE_PROMPT, ... };
   }
   ```

### 5. Custom SCM Provider
**Location**: `src/platform/scm-client.ts`

Implement `ScmClient` interface:

```typescript
export class CustomScmClient implements ScmClient {
  async createPullRequest(...): Promise<PullRequestRef> { /* ... */ }
  async mergePullRequest(...): Promise<PullRequestMergeStatus> { /* ... */ }
  async getPullRequestStatus(...): Promise<PullRequestStatus> { /* ... */ }
  // ...
}
```

Add to `createScmClient()` factory:
```typescript
case 'custom':
  return new CustomScmClient(config);
```

### 6. Custom Workflow Action Parser
**Location**: `src/platform/kanban-workflow-parser.ts`

Add custom directive parsing to `parseKanbanAction()`:

```typescript
export function parseKanbanAction(text: string): KanbanAction | null {
  // Existing: KANBAN_ACTION:SUBMIT_REVIEW, etc.
  
  if (text.includes('KANBAN_ACTION:CUSTOM_ACTION')) {
    return { type: 'custom_action', payload: { /* parse details */ } };
  }
  
  return null;
}
```

Handle in `applyKanbanWorkflowAction()` in `src/platform/workflow-service.ts`:
```typescript
case 'custom_action':
  await this.handleCustomAction(taskSessionId, action.payload);
  break;
```

### 7. Custom Delivery Renderer
**Location**: `src/lib/bridge/delivery-layer.ts`, `src/lib/bridge/markdown/`

Add platform-specific markdown rendering:

1. Create `src/lib/bridge/markdown/custom-platform.ts`:
   ```typescript
   export function renderForCustomPlatform(text: string): string {
     // Transform markdown to platform-specific format
   }
   ```

2. Update `DeliveryLayer.send()` to route to new renderer:
   ```typescript
   case 'custom_platform':
     const formatted = renderForCustomPlatform(text);
     await adapter.send(chatId, formatted);
     break;
   ```

### 8. Task Lifecycle Hooks
**Location**: `src/platform/workflow-service.ts`

Inject custom behavior via callbacks:

```typescript
export class WorkflowService {
  constructor(
    // ...
    private readonly hooks?: {
      beforeStateTransition?: (task: TaskSession, newState: TaskWorkflowState) => Promise<void>;
      afterStateTransition?: (task: TaskSession, oldState: TaskWorkflowState) => Promise<void>;
      onTestFailure?: (task: TaskSession, failure: TaskFailurePayload) => Promise<void>;
      // ...
    }
  ) {}
  
  private async transitionTaskState(taskId: string, newState: TaskWorkflowState): Promise<void> {
    const task = this.store.getTaskSession(taskId);
    await this.hooks?.beforeStateTransition?.(task, newState);
    // ... perform transition
    await this.hooks?.afterStateTransition?.(task, oldState);
  }
}
```

### 9. Custom Platform Storage Backend
**Location**: `src/platform/json-platform-store.ts`

Implement `PlatformStore` interface (abstract from `JsonPlatformStore`):

```typescript
interface PlatformStore {
  saveProject(project: Project): void;
  getProject(id: string): Project | null;
  // ... all store methods
}
```

Inject into `WorkflowService` and `InstanceManager` constructors.

### 10. Monitoring & Observability
**Location**: `src/platform/app.ts`, `src/platform/json-platform-store.ts`

Tap into existing monitor APIs:

- **GET `/api/kanban/monitor`**: Real-time agent activity
- **GET `/api/kanban/agent/turns`**: Agent turn history
- **Monitor turns schema**: Includes `toolStartMs`, `toolEndMs`, `toolNames`, `status`, `hasResult`

Add custom metrics by extending `KanbanAgentMonitorTurn` type and updating `buildKanbanMonitorTurnRecord()` in `src/platform/kanban-agent-turn.ts`.

---

## Key Design Principles

1. **Queue-driven over event-driven**: Task queues provide natural backpressure and replay
2. **Runtime abstraction**: Unified provider interface enables polyglot AI execution
3. **State machine rigor**: Explicit workflow states and transitions prevent invalid flows
4. **Session isolation**: Per-chat locks and runtime session guards prevent interference
5. **Graceful degradation**: Preview failures, timeout retries, and error recovery preserve core functionality
6. **Restart resilience**: Persistent queues and instance reconciliation survive crashes
7. **Separation of concerns**: Bridge, workflow, instance manager, and runtime layers have clear boundaries
8. **Dependency injection**: Bridge context enables swappable implementations for testing and extension

---

## Directory Structure Reference

```
agent-im/
├── src/
│   ├── main.ts                    # Bridge daemon entrypoint
│   ├── config.ts                  # Configuration loading
│   ├── store.ts                   # Bridge JSON file store
│   ├── runtime-provider.ts        # Runtime abstraction
│   ├── {llm,codex,cursor,copilot}-provider.ts  # Provider implementations
│   ├── permission-gateway.ts      # Approval resolution
│   │
│   ├── lib/bridge/                # IM bridge subsystem (93 files)
│   │   ├── bridge-manager.ts      # Orchestrator
│   │   ├── channel-router.ts      # Session binding
│   │   ├── conversation-engine.ts # LLM interaction
│   │   ├── permission-broker.ts   # Approval flow
│   │   ├── delivery-layer.ts      # Outbound delivery
│   │   ├── adapters/              # IM platform integrations
│   │   │   ├── telegram-adapter.ts
│   │   │   ├── discord-adapter.ts
│   │   │   ├── feishu-adapter.ts
│   │   │   └── qq-adapter.ts
│   │   └── markdown/              # Platform renderers
│   │
│   ├── platform/                  # Workflow engine (55 files)
│   │   ├── app.ts                 # HTTP router
│   │   ├── container.ts           # DI bootstrap
│   │   ├── workflow-service.ts    # State machine
│   │   ├── instance-manager.ts    # Agent lifecycle
│   │   ├── json-platform-store.ts # SQLite persistence
│   │   ├── git-service.ts         # Git operations
│   │   ├── scm-client.ts          # PR management
│   │   ├── kanban-agents.ts       # Role definitions
│   │   ├── kanban-workflow-parser.ts  # Action parsing
│   │   └── prompts/               # Role templates
│   │
│   └── app/                       # Next.js UI
│       ├── page.tsx               # Landing page
│       ├── admin/                 # Bridge config
│       ├── projects/              # Project management
│       ├── board/                 # Kanban board
│       └── monitor/               # Agent monitoring
│
├── data/platform/                 # Platform SQLite DB
├── ~/.claude-to-im/<bot>/         # Bridge data (per bot)
│   ├── data/                      # JSON store
│   │   ├── sessions.json
│   │   ├── bindings.json
│   │   └── messages/
│   └── runtime/status.json        # Daemon status
│
└── docs/
    ├── API.md                     # HTTP API reference
    ├── PROJECT-UNDERSTANDING.md   # Codebase walkthrough
    └── LOGS.md                    # Log locations
```

---

## Relevant Documentation

- **[README.md](README.md)**: Product overview, quick start, capabilities
- **[docs/PROJECT-UNDERSTANDING.md](docs/PROJECT-UNDERSTANDING.md)**: Detailed codebase walkthrough
- **[docs/API.md](docs/API.md)**: HTTP API reference
- **[src/lib/bridge/ARCHITECTURE.md](src/lib/bridge/ARCHITECTURE.md)**: Bridge subsystem deep dive
- **[SECURITY.md](SECURITY.md)**: Security considerations
- **[DESIGN.md](DESIGN.md)**: UI design system

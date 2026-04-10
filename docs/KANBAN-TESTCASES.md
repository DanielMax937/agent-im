# Kanban 工作流测试用例

> 覆盖范围：所有状态流转、覆盖率机制、私有仓库 CI lane、快速通道、UAT、阻塞/解除阻塞、关单（同步 / 异步）等功能。  
> 运行前提：已启动服务，至少存在一个 Project。Board 地址：`/board`。自动化回归：`npm run test:kanban:full`（`scripts/kanban-full-test-runner.mjs`）。

**自动化与手工**

- **不依赖浏览器快照**：全量脚本不通过 Chrome DevTools 对 Board 做 DOM/截图断言（原 P2-ui / P3-ui、T4、SH6 等改为 **API** 或标为 **手工**）。
- **Agent / 提示词类用例**：优先用 **`GET /api/kanban/monitor?taskSessionId=…`**（与 Monitor 页同一数据源）检查 `targetAgentPrompt` / `sourceAgentResponse` 等字段，而不是看 Board 上的 Agent 回复。
- **仍建议 Board 手工核对**：空交接、创建表单校验、🔒 图标、CI 等待卡片上的「手动推进」禁用、剪贴板复制 Webhook 等。

**与当前源码对齐要点（摘要）**

- **Kanban lane（`/api/projects/:id/kanban-roles`）** 固定 **5 类**：`agent-dev`、`pre-tester`、`codex-senior`、`claude-review`、`copilot-test`。分配任务前每条 lane 需在 `kanbanRoleRunners`（或 roster）中有可用 runner（见 `KANBAN_AGENT_LANES_REQUIRING_DEFAULT_RUNNER`）。**`self-host-runner` 不在该列表中配置**，由工作流在**私有仓回归**时自动写入任务，用于等 CI 回调。
- **关单**：看板「标记完成」调用 **`POST /api/workflows/tasks/:taskSessionId/close`（同步）**，`pending_release` → **`closed`**，**不经过** `closing`。**`POST .../close-async`** 才会先进入 `closing` 再后台执行与 `closeTask` 相同校验。
- **CI 回调失败**：`POST .../ci-result` 且 `status: failure` 时调用 `returnTestingToDevelopment`，任务回到 **`in_progress`**（见 `processCiCallback`）。

---

## 目录

1. [前置条件](#0-前置条件)
2. [Sprint（迭代）](#1-sprint-迭代)
3. [创建任务 todo](#2-创建任务-todo)
4. [开发 in_progress](#3-开发-in_progress)
5. [预测试 pre_testing](#4-预测试-pre_testing)
6. [功能测试 testing](#5-功能测试-testing)
7. [评审 review](#6-评审-review)
8. [回归测试 regression_testing（公开仓库）](#7-回归测试-regression_testing公开仓库)
9. [回归测试 regression_testing（私有仓库 self-host-runner）](#8-回归测试-regression_testing私有仓库-self-host-runner)
10. [UAT pending_uat](#9-uat-pending_uat)
11. [待发布 pending_release](#10-待发布-pending_release)
12. [关单：同步 close 与异步 close-async](#11-关单同步-close-与异步-close-async)
13. [阻塞 blocked](#12-阻塞-blocked)
14. [快速通道（Hotfix）](#13-快速通道hotfix)
15. [覆盖率管理](#14-覆盖率管理)
16. [测试失败补偿](#15-测试失败补偿)
17. [完整快乐路径（公开仓库）](#16-完整快乐路径公开仓库)
18. [完整快乐路径（私有仓库）](#17-完整快乐路径私有仓库)
19. [边界与异常](#18-边界与异常)

---

## 0. 前置条件

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| P1 | 服务启动 | 启动 `npm run dev`；`GET /health` 返回 `ok`；`GET /board` 返回 200 | 服务可用；全量脚本不跑浏览器 JS 检查 |
| P2 | 公开仓库项目 | 在 `/projects` 创建项目，**不勾选** "私有仓库"；配置有效的 localPath、baseBranch、SCM 信息 | `GET /api/projects/:id` 中 **`isPrivate: false`**；🔒 图标以 Board **手工**为准 |
| P3 | 私有仓库项目 | 在 `/projects` 创建项目，**勾选** "私有仓库" | `GET /api/projects/:id` 中 **`isPrivate: true`**；🔒 图标以 Board **手工**为准 |
| P4 | UAT 项目 | 在 `/projects` 创建项目，勾选 `requiresUat` | 后续回归后会进入 `pending_uat` 状态 |
| P5 | 覆盖率命令 | 在 `/projects` 项目中填写 `coverageCommand`（如 `npm run test:coverage`） | 后续关闭流程可执行覆盖率检查 |
| P6 | Git & 远端 | 确保 localPath 下 git 正常，`origin` fetch 可用 | 后续 PR/回归步骤不报 git 错误 |

---

## 1. Sprint（迭代）

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| SP1 | 新建 Sprint | `POST /api/workflows/sprints/start` 传入 `projectId`、`sprintName` | Sprint 创建成功；`feature/<prefix><slug>` 分支出现在远端 |
| SP2 | Board 下拉 | 在 `/board` 选择项目 | Sprint 列表加载；可选择 Sprint |
| SP3 | 重复 Sprint | 相同 `sprintName` 再次创建 | 报错：Sprint 已存在 |

---

## 2. 创建任务 todo

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| T1 | 正常创建 | 选择项目+Sprint+唯一 issueId+标题 → 点击 **创建** | 卡片出现在 **待办** 列；`workflowState = todo` |
| T2 | 创建 Hotfix 任务 | 勾选 **快速通道（Hotfix）** → 创建 | 卡片出现 **HOTFIX** 橙色徽章；`isHotfix = true` |
| T3 | 重复 issueId | 相同 issueId 再次创建 | 报错：任务已存在 |
| T4 | 缺少必填项 | 不填项目/Sprint/issueId/标题 → 创建 | UI 提示"请选择项目…"（**手工**；全量脚本不覆盖） |

---

## 3. 开发 in_progress

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| A1 | 正常分配 | 填写**交接说明**；选 lane（agent-开发/codex-高级开发）→ **分配并启动 runner** | 卡片移至 **开发中**；branch/worktree 创建；runner 启动；workflow 评论记录分配 |
| A2 | 缺少交接说明 | 清空交接说明 → 分配 | UI 报错"分配前请填写交接说明…"（**手工**；全量脚本不覆盖） |
| A3 | 依赖任务未完成 | 为任务设置 `dependsOnIssueIds`（依赖项未到 `pending_release`）→ `POST /api/workflows/tasks/assign` | 任务可保持 **`pending_start`** 排队等待依赖；看板可能提示依赖未满足（与 `kanban-full-test-runner` A3 一致，未必返回 HTTP 错误） |
| A4 | 2 次评审打回后分配 | `reviewRejectionCount ≥ 2` 时，选 agent-开发 → 分配 | 服务端自动升级为 **codex-高级开发**；runner 以 codex-senior 启动 |
| A5 | pending_release 移入时 runner 关闭 | 任务从 `regression_testing` 进入 `pending_release` | 对应任务 runner 实例自动停止 |

---

## 4. 预测试 pre_testing

> 非 Hotfix 任务在开发完成后进入 `pre_testing`，由 `pre-tester` lane 执行。

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| PT1 | 进入预测试 | 开发完成 → system-check 触发 → 进入预测试 | 卡片移至 **预测试**；`kanbanAgent = pre-tester`；runner 启动 |
| PT2 | 预测试通过 → 功能测试 | pre-tester runner 完成 → 触发进入 `testing` | 卡片移至 **测试中** |
| PT3 | Hotfix 跳过预测试 | `isHotfix = true` 的任务 START_TESTING | 直接进入 `testing`，跳过 `pre_testing` |

---

## 5. 功能测试 testing

> `agent-dev` system-check 和回归 prompt 均要求有单测及覆盖率报告。

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| E1 | 进入测试 | 从 **评审中** → **进入测试（copilot-测试）** | 卡片移至 **测试中**；`kanbanAgent = copilot-test`；tester runner 启动 |
| E2 | 测试需包含单测 | （行为由 Agent 执行） | 自动化：任务进入 `testing` 且 `kanbanAgent=copilot-test` 后，在 **`GET /api/kanban/monitor`** 中存在含 **`Tester rule:`** 且提到 **unit test(s)** 的 `targetAgentPrompt`（与 Monitor 表一致） |
| E3 | 测试需覆盖率报告 | （行为由 Agent 执行） | 自动化：同上 Monitor 行中 `targetAgentPrompt` 含 **`coverage-summary` / `coverage.json`** 等覆盖率产出要求 |

---

## 6. 评审 review

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| R1 | 提交评审 | 可选填 commit/PR 字段 → **提交评审（claude-review）** | 状态 **评审中**；PR URL 显示在卡片；reviewer runner 启动；workflow 评论包含 PR 信息 |
| R2 | 评审通过并合并 PR | 在 **review** 状态下由 Agent 执行 **`APPROVE_MERGE`**（或等价逻辑调用 `mergeApprovedPullRequestAndStartRegression`）合并评审 PR | 合并成功后进入 **`regression_testing`**（公开仓启动 tester；私有仓见 §8） |
| R3 | 打回开发 | 填写**打回说明** → **打回开发** | 卡片回 **开发中**；`reviewRejectionCount +1`；developer runner 重启；评论记录打回原因 |
| R4 | 打回说明必填 | 空打回说明 → 打回 | UI 报错"打回时请填写说明…" |
| R5 | 打回因覆盖率不足 | 打回原因为覆盖率不达标 | Agent 必须先保证改动代码的覆盖率已覆盖，再为覆盖率最低文件编写单测，直到达标 |

---

## 7. 回归测试 regression_testing（公开仓库）

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| G1 | 进入回归 | 合并评审 PR → 触发回归 | 卡片移至 **回归测试中**；`regressionMasterSha` 记录；regression runner 启动；评论含 master SHA |
| G2 | 覆盖率达标 | runner 运行全量单测，获取最新覆盖率报告，覆盖率 ≥ 接口返回的项目最新覆盖率 | 继续进入 `pending_release` |
| G3 | 覆盖率不足 | runner 覆盖率 < 项目当前最低覆盖率 | 打回开发；评论包含"需达到的最低覆盖率为 X%"提示 |
| G4 | Master 前进检测 | `POST /api/workflows/tasks/:id/regression/refresh` | 基准更新；handoff 提示丢弃旧 checkout；runner 重启 |
| G5 | 非回归状态调用 refresh | 任务不在 `regression_testing` 时调用 refresh | API 报错 |

---

## 8. 回归测试 regression_testing（私有仓库 self-host-runner）

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| SH0 | GitHub Actions 在 self-hosted 上执行 | 首次推送含 `kanban-e2e-selfhosted.yml`（`runs-on` 与 `KANBAN_E2E_GHA_RUNS_ON` 一致） | 轮询 `gh api …/actions/runs/…/jobs`：至少一个 **已完成** job 的 `labels` 包含全部期望标签（默认仅 `self-hosted`） |
| SH1 | 私有仓库进入回归 | 合并评审 PR（`isPrivate = true`） | 合并后不启动 AI runner；`kanbanAgent = self-host-runner`；**⏳ CI 等待中** 与 Webhook 文案以 Board **手工**为准 |
| SH2 | Webhook URL 可见 | 合并后 workflow 评论 / handoff 中给出回调说明 | 自动化：`GET /api/tasks/:taskSessionId` 的 **`historyComments` / `handoffComment`** 中含 **`ci-result`** 路径（与复制按钮目标一致；**剪贴板**为手工） |
| SH3 | CI 成功回调 | `POST /api/workflows/tasks/:id/ci-result` body `{ "status": "success", "coverage": 85 }` | 任务进入 `pending_release`；`coverage` 被记录 |
| SH4 | CI 失败回调 | body `{ "status": "failure", "reason": "Unit tests failed" }` | 任务返回 `in_progress`；workflow 评论包含失败原因 |
| SH5 | 非法状态回调 | 任务不在 `regression_testing` 或 `kanbanAgent ≠ self-host-runner` 时调用 | API 报错（状态不匹配） |
| SH6 | Board 手动操作禁用 | `self-host-runner` 等待中的卡片 | 不显示手动推进按钮（**手工**；全量脚本不覆盖） |

---

## 9. UAT pending_uat

> 仅当 `Project.requiresUat = true` 时激活此状态。

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| U1 | 进入 UAT | 回归测试通过，`requiresUat = true` | 卡片移至 **UAT** 列；等待人工确认 |
| U2 | UAT 通过 | 点击卡片 ✅ **UAT 通过** | 进入 `pending_release` |
| U3 | UAT 拒绝 | `POST /api/workflows/tasks/:id/uat-reject`，body `{"reason":"..."}`（或 Board 点击 ❌ **UAT 拒绝** 并输入原因） | 进入 **`regression_testing`**；**tester** runner 重新启动（`uatReject`） |
| U4 | 不需要 UAT | `requiresUat = false` 的项目回归后 | 直接进入 `pending_release`，跳过 `pending_uat` |

---

## 10. 待发布 pending_release

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| PR1 | 进入待发布 | 从 `regression_testing`/`pending_uat` 到达 `pending_release` | 卡片移至 **待发布** 列；关联 runner 自动停止 |
| PR2 | 任务关闭（pending_release → closed） | 点击 **标记完成** | 触发异步关闭流程（见 §11） |
| PR3 | 从 pending_release 移至 closed（未合并 PR） | 迭代分支 PR 未合并到 master，尝试关闭 | 阻止操作；弹窗提示"PR 尚未合并" |

---

## 11. 关单：同步 close 与异步 close-async

> **`closeTask`（`workflow-service.ts`）**：校验 release PR 已合并、`runCoverageAndUpdateAfterClose`（worktree 上跑测试与覆盖率），通过后 **`pending_release` → `closed`**。  
> **看板默认**：`POST /api/workflows/tasks/:taskSessionId/close` — **同步**执行上述逻辑，**不进入** `closing`。  
> **异步**：`POST /api/workflows/tasks/:taskSessionId/close-async` — 立即 **`pending_release` → `closing`** 并返回，后台再调用 `closeTask`；成功则 `closed`；失败则回退 **`pending_release`** 并追加评论。

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| CL1 | 正常关闭（Board 默认） | PR 已合并；点击 **标记完成**（`POST .../close`） | **不经过** `closing`；请求完成后 **`closed`**；覆盖率逻辑在**同一请求**内执行；worktree 清理见 `closeTask` / `runCoverageAndUpdateAfterClose` |
| CL1a | 异步关单 | `POST .../close-async` | 立即 **`closing`**；后台成功则 **`closed`**；失败回退 **`pending_release`** 并写「关闭验证失败」类评论 |
| CL2 | 覆盖率更新 | 关闭时运行单测覆盖率高于接口记录 | `updateProjectCoverage` 提升项目水位；`coverage/history` 有记录 |
| CL3 | 覆盖率未提升 | 运行结果低于已记录最高覆盖率 | 水位不提升；history 仍可记本次（见 store 行为）；任务仍可关闭 |
| CL4 | 单测运行报错 | 运行测试中出现错误 | **`close` 抛错**，HTTP 4xx；**同步路径不会**先进入 `closing` |
| CL5 | 覆盖率未达标 | 低于要求下限 | 同上，**close 抛错**阻止关单 |
| CL6 | 批量关闭 | 看板勾选多个 **待发布** 任务 **标记完成** | 对每个任务依次 `POST .../close`（同步）；各自独立成功/失败 |
| CL7 | `closing` 展示 | 仅在使用 **`close-async`** 且后台尚未结束时刷新 Board | 卡片在 **待发布** 列带 ⏳、状态 **`closing`**；**纯 `/close` 路径无此状态** |

---

## 12. 阻塞 blocked

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| B1 | 阻塞任务 | 任务处于 `in_progress`/`testing`/`review` 等活跃状态 → 点击 **🚫 阻塞** 并填写原因 | 卡片移至 **阻塞** 列；`blockedFromState` 记录原始状态；`blockReason` 显示；关联 runner 停止 |
| B2 | 解除阻塞 | 点击 **✅ 解除阻塞** | 卡片恢复到 `blockedFromState` 对应的列；runner 不自动重启（需手动分配） |
| B3 | 阻塞原因必填 | 空原因提交 | UI 校验拒绝 |
| B4 | 已关闭任务不可阻塞 | `closed` 任务尝试阻塞 | 报错：不支持该状态的阻塞操作 |

---

## 13. 快速通道（Hotfix）

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| HF1 | 创建 Hotfix 任务 | 勾选 **快速通道（Hotfix）** 创建任务 | 卡片显示 **HOTFIX** 橙色徽章 |
| HF2 | 跳过预测试 | Hotfix 任务分配后执行 START_TESTING | 直接进入 `testing`（跳过 `pre_testing`）；评论说明为 hotfix 通道 |
| HF3 | 后续流程不变 | Hotfix 任务进入 `testing` 后 | 后续 review → regression → pending_release → closed 流程与普通任务一致 |

---

## 14. 覆盖率管理

### 14.1 覆盖率接口

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| CV1 | 获取初始覆盖率 | `GET /api/projects/:id/coverage` | 返回 `{ coverage: 0 }`（项目初始值） |
| CV2 | 上报更高覆盖率 | `POST /api/projects/:id/coverage` body `{ "coverage": 78, "context": "sprint-3" }` | 覆盖率更新为 78；返回 `{ updated: true, coverage: 78 }` |
| CV3 | 上报更低覆盖率 | `POST /api/projects/:id/coverage` body `{ "coverage": 50 }` | 覆盖率不变；返回 `{ updated: false, coverage: 78 }` |
| CV4 | 上报等值覆盖率 | `POST /api/projects/:id/coverage` body `{ "coverage": 78 }` | 覆盖率不变；返回 `{ updated: false, coverage: 78 }` |
| CV5 | 覆盖率历史 | `GET /api/projects/:id/coverage/history?limit=10` | 返回最多 10 条历史记录，按时间降序排列 |
| CV6 | 历史含上报更低值 | 多次上报，包括低于当前最高值 | 历史表每次上报均记录；最高覆盖率字段仅在提升时更新 |

### 14.2 覆盖率与回归

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| CV7 | 回归要求覆盖率 ≥ 记录值 | 项目当前覆盖率 80%；回归运行结果 75% | 打回开发；评论："需达到最低覆盖率 80%" |
| CV8 | 回归覆盖率达标 | 回归运行结果 82% | 通过；进入 `pending_release` |
| CV9 | 打回因覆盖率不足（与 R5 语义相关） | 评审 / 回归侧对覆盖率的约束 | 文档级行为以 Agent 执行为准；自动化：在 **G3 回归失败路径** 跑完后，**`GET /api/kanban/monitor`** 中存在含 **coverage-summary / minimum required coverage / lowest-coverage** 等字样的 `targetAgentPrompt`（回归测试 lane 提示词） |

---

## 15. 测试失败补偿

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| F1 | testing 中报告失败 | `POST /api/workflows/tasks/:taskSessionId/testing/fail`，body **`{ "summary": "...", "log": "..." }`**（task id 在 **URL**）；任务在 `testing` | `handleTestFailure` 将任务退回 **`in_progress`**；workflow 评论记录摘要 |
| F2 | regression 中报告失败 | 同上，任务在 `regression_testing`（且非 `self-host-runner` 等由 CI 独占的路径） | 同 F1，退回 **`in_progress`** |
| F3 | 非测试状态报告失败 | 任务在 `todo`/`review` 等状态调用 fail API | 报错：任务不在测试中 |

---

## 16. 完整快乐路径（公开仓库）

> 以一个普通任务为例，按顺序验证每个状态流转。

```
Sprint 创建
    ↓
创建任务 (todo)
    ↓
分配开发 (in_progress) ← 含交接说明
    ↓
预测试通过 (pre_testing → testing)
    ↓
测试通过，含单测 & 覆盖率报告 (testing → review)
    ↓
评审通过 (review → regression_testing)
    ↓
全量回归，覆盖率 ≥ 项目记录 (regression_testing → pending_release)
    ↓
runner 自动停止
    ↓
PR 已合并，点击关闭 → closing → 单测运行 → 覆盖率更新 → closed
```

验证要点：
- 每一步板上列名变化正确
- runner 在 `pending_release` 时停止
- 覆盖率历史新增一条
- 使用默认 **`/close`** 时无 `closing` 态；worktree/覆盖率在 `closeTask` 内完成

---

## 17. 完整快乐路径（私有仓库）

```
Sprint 创建
    ↓
创建任务 (todo)
    ↓
分配开发 (in_progress)
    ↓
预测试 → 功能测试 → 评审
    ↓
评审通过 → 合并 PR → regression_testing (self-host-runner)
  • 板上显示 ⏳ CI 等待中
  • 无 AI runner 启动
  • Webhook URL 记录在评论中
    ↓
CI 调用 POST /api/workflows/tasks/:id/ci-result { "status":"success", "coverage":90 }
    ↓
pending_release → 关闭流程（同公开仓库 §11）
```

验证要点：
- `self-host-runner` 期间无 AI 实例
- Webhook URL 格式正确，可复制
- CI 成功/失败均有对应状态变化

---

## 18. 边界与异常

| # | 用例 | 步骤 | 期望 |
|---|------|------|------|
| EX1 | 非法状态流转 | `POST /api/workflows/tasks/:id/close` 任务在 `todo` | 报错：无效的状态流转 |
| EX2 | 并发请求 | 自动化脚本对 **`GET /health` 并发两次** 均成功（`kanban-full-test-runner`） | 服务可同时处理并发只读请求；若需验证「同一任务并发工作流写」需自写脚本 |
| EX3 | 项目不存在 | 使用不存在的 projectId 创建任务 | 报错：项目不存在 |
| EX4 | Sprint 不属于项目 | 使用其他项目的 sprintId | 报错：Sprint 与项目不匹配 |
| EX5 | 数据库迁移 | 在旧版本 SQLite 上启动新版本（`JsonPlatformStore` 含 `project_coverage_history` 等表） | Schema 升级；`sqlite3` 可校验表存在（或依赖 **CV5** `GET /coverage/history`） |
| EX6 | worktree 残留 | 关闭流程中途崩溃重启 | 重启后 worktree 目录不自动删除（需人工清理）；任务状态回退到 `pending_release` |
| EX7 | CI 回调重复 | 同一任务已到 `pending_release` 后再次发送 ci-result | 报错：任务不在 `regression_testing` 状态 |

---

## 相关代码位置

| 模块 | 路径 |
|------|------|
| 状态流转 | `src/platform/workflow-service.ts` |
| HTTP 端点 | `src/platform/app.ts` |
| 类型定义 | `src/platform/types.ts` |
| 数据持久化 | `src/platform/json-platform-store.ts` |
| Board UI | `src/app/board/page.tsx` |
| 项目管理 UI | `src/app/projects/page.tsx` |
| Lane 默认 runner / 分配 | `src/platform/kanban-role-assign.ts` |
| Kanban prompt / lane 技能默认 | `src/platform/kanban-agents.ts` |
| 配置与 `CTI_RUNNERS` | `src/config.ts` |
| 全量用例自动化 | `scripts/kanban-full-test-runner.mjs`、`scripts/kanban-test-lib.mjs` |
| 单元测试 | `src/__tests__/workflow-service.test.ts` |

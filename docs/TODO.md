# agent-im TODO

项目待办 backlog（按模块分组）。完成某项后删除或勾选对应条目。

---

## Research 模式

### [ ] `POST /api/research/:id/continue` — 同一 session 续跑（maxTurns 用尽后）

**背景：** 当前 `POST /api/research` 只能**新建**会话。达到 `maxTurns` 后 `phase` 变为 `timeout` 并结束，无法对同一 `sessionId` 接着跑。用户只能再次 `POST` 同目录、更大 `maxTurns`，会得到**新** `sessionId`，且 A/B **不会**自动加载上一轮 transcript。

**目标：** 在已有 session 上延长轮次并恢复 orchestrator，保留上下文。

**建议接口：**

```
POST /api/research/:sessionId/continue?folder=<abs-path>
```

或 JSON body：

```json
{
  "folder": "/path/to/project",
  "additionalMaxTurns": 12,
  "maxTurns": 48
}
```

**行为要点（实现时参考）：**

- `folder` 必填，与启动时一致；校验 `state.json` 存在且 `phase` 为终态（至少支持 `timeout`，可选 `failed` / `aborted`）。
- 将 `maxTurns` 提高（`additionalMaxTurns` 累加或 `maxTurns` 设新上限），`turn` 从当前值继续，不把 transcript 清零。
- 复用同一 session 的 `sessionIdA` / `sessionIdB`（及 binding / LLM 上下文），从 `lastStatus` / `lastVerdict` 或 transcript 最后一轮构造 follow-up，而非重新 `goal-bootstrap`。
- 续跑完成后仍写 `result-<sessionId>.md`（可追加「续跑」段落或覆盖，实现时定一种策略）。
- Telegram：续跑期间仍按现有逻辑推送每条 `[researcher]` / `[reviewer]` 回复。
- 文档：更新 `src/lib/bridge/research-mode/README.md` 与 `docs/API.md`（若有时）。

**相关文件：**

- `src/lib/bridge/research-mode/orchestrator.ts` — `startResearchSession` / `runOrchestratorLoop`
- `src/lib/bridge/research-mode/session-store.ts` — `readState` / `writeState` / `markFinished`
- `src/app/api/research/route.ts`、`src/app/api/research/[id]/route.ts` — 新增 route 或子路径

**临时变通（已实现前）：** 再 `POST /api/research` 同 `folder` + 更大 `maxTurns`，并在 `goal.md` 中写明续跑说明与上一轮 artifact 路径。

---

### [ ] 任务启动前必读 `reference/`（除 `goal.md` 外）

**背景：** 当前 bootstrap 只把 `goal.md` 注入 Agent A / B；工作目录里往往还有大量 handoff、赛题说明、历史 attempt、协议文档散落在根目录或 `01_*.md`。仅靠 `goal` 容易漏读「未写进 goal 但任务假定你已读过」的材料。

**目标：** 会话**正式开始编排前**（或首轮 plan 之前），强制覆盖阅读 `<folder>/reference/` 下的**全部**参考文件（可配置目录名），并在 transcript / state 中留下「已读清单」证明，Researcher 与 Reviewer 均基于同一套参考上下文。

**设计思路（概要，不落实现）：**

1. **目录约定**
   - 默认路径：`<folder>/reference/`（只读；Agent 产物仍写在 `folder` 根或 `output/` 等，避免改乱参考）。
   - 可配置：`Config.research.referenceDir` 或 `POST /api/research` 传 `referenceDir` 覆盖（默认 `reference`）。
   - `goal.md` 保留在 `folder` 根；`reference/` 内可任意层级子目录，支持 `.md`、`.txt`、`.json`、代码片段等；大二进制（PDF/parquet）走「路径 + 元数据 + 可选预生成摘要文件」策略。

2. **启动前流程（orchestrator 扩展）**
   - `POST /api/research` 校验：`goal.md` 存在；若启用必读 reference，则 `reference/` 存在且非空（或允许空目录但配置显式 `referenceRequired: false`）。
   - **索引阶段：** 递归列举 `reference/**`，生成 `reference-manifest.json` 写入 `.research/sessions/<id>/`（路径、大小、mtime、sha256 可选）。
   - **注入阶段：** 按 token 预算组装「Reference Pack」——小文件全文、大文件用已有 `*.summary.md` 或 orchestrator 调 LLM 预摘要（可选开关，仅 session 启动时一次）。
   - **确认阶段：** bootstrap prompt 明确要求 A 在 `RESEARCH_A_STATUS_JSON` 前列出 `referencesRead: [相对路径…]`；B 首轮评审 prompt 附带同一 manifest，要求核对 A 是否遗漏关键 reference。

3. **与每轮重读的关系**
   - `goal.md`：仍每轮重读（现有行为）。
   - `reference/`：**首轮全量**进入上下文；后续轮次可按 manifest 做增量（仅 `reference/` 有变更时重新 pack）或按 reviewer 打回关键词检索片段，避免每轮重复塞满 200 轮 × 全库。
   - 可选：将 reference 全文/摘要同步进「主题知识库」条目，供后续检索（见下条 Topic KB）。

4. **API / 配置**
   - `Config.research.reference`: `{ dir: "reference", required: true, maxTotalChars, maxFileBytes, globIgnore: ["**/.git/**"] }`。
   - 启动失败语义：`reference required but missing or empty` 返回 400，避免空跑。

5. **可观测性**
   - Transcript 增加 `kind: reference-index`（文件数、总字符、截断说明）。
   - Telegram 启动通知附带：`reference: N files, M KB indexed`。
   - `result-<sessionId>.md` 附录「References consulted」链接 manifest。

6. **边界**
   - `reference/` 只读；工具权限禁止 Agent 写入该目录。
   - 超大目录（上千文件）需硬上限 + 明确报错，提示用户拆分子集或提供 `reference/README.md` 索引。

**与主题知识库的关系：** `reference/` 偏**任务交付物、赛题 handoff 的必读全集**；Topic KB 偏**可检索、可跨任务复用的领域知识**。二者可并存：启动时先 ingest `reference/` 进 session manifest，再按需把条目同步进 KB 索引供会诊/打回时使用。

---

### [ ] Research 主题知识库（Topic Knowledge Base）

**背景：** 当前 Research 模式主要依赖 `goal.md` + 工作目录内已有文件；Agent A 每轮会重读 `goal.md`，但没有与**任务主题**绑定的、可检索的「领域知识层」。竞赛/量化/ML 等长任务容易反复踩同一类坑，或遗漏赛题文档里的隐含约束。

**目标：** 为每个 Research 任务（或 `folder`）挂载一份**主题相关知识库**，供 Researcher / Reviewer 在计划、执行、评审时引用，减少「只靠当轮上下文」的信息丢失。

**设计思路（概要，不落实现）：**

1. **知识来源**
   - 用户显式提供：`folder/knowledge/` 或 `folder/.research/knowledge/` 下的 markdown / PDF 摘要 / 链接清单。
   - 可选自动 ingest：把 `goal.md` 引用的 `01_*.md` 等 handoff 文档索引进库；赛题 baseline、规则、历史 attempt 单独打 tag。
   - 与全局 Obsidian vault / 公司 wiki 的**可选**只读挂载（配置 `research.topicKnowledgePaths`），避免和 IM bot 配置耦合。

2. **存储与检索**
   - 轻量方案：目录 + frontmatter 标签 + 文件名索引；orchestrator 在 bootstrap / follow-up 时注入「相关片段摘要」（按 goal 关键词或 reviewer 打回原因选段）。
   - 进阶方案：按 `folder` 建本地向量索引（或复用现有 knowledge vault 编译管线），`POST /api/research` 时可传 `knowledgeProfile: "competition-futures"` 指向预置 corpora。

3. **使用时机**
   - **Bootstrap：** Agent A 首轮除 `goal.md` 外，附带 Top-K 知识库摘要（赛题规则、评估协议、禁止泄漏条款等）。
   - **Reviewer：** Agent B 评审时对照知识库中的「硬约束清单」打勾（如 leave-month、无在线反馈、提交格式）。
   - **Transcript：** 记录引用了哪些 doc id，便于 Telegram / 结果 markdown 里可追溯。

4. **配置面**
   - 顶层 `Config.research.topicKnowledge`：`{ enabled, defaultIngestGlob, maxInjectChars }`。
   - Admin「Research 模式」增加可选「默认知识库 profile」说明，不强制 UI 编辑器。

5. **边界**
   - 知识库只读；写入仍发生在工作目录产物里。
   - 不把整库塞进每轮 prompt（token 预算）；以「检索摘要 + 引用指针」为主。

---

### [ ] Reviewer 连续打回时的「资深专家会诊」（Expert Council）

**背景：** 当 Agent B 多次 `request-changes` / `reject-complete`，Agent A 容易在同一思路上打转，仅靠 B 的 advice 迭代计划仍可能缺「领域范式」层面的突破（例如量化竞赛里的因子构造、时序 CV、风险约束表述方式）。

**目标：** 在**连续被 Reviewer 打回**达到阈值时，允许 orchestrator 临时拉起若干**专家角色实例**（有名有方法论），Researcher 可向其「求救」一次或有限轮次，再把共识整理回主循环。

**设计思路（概要，不落实现）：**

1. **触发条件**
   - 统计连续 `request-changes` 或「计划阶段未 approve-plan」次数 ≥ N（如 3），或同一 `verdict` 类型连续出现。
   - 可选：Reviewer advice 文本相似度过高（停滞检测）时也触发。
   - 每 session 限制会诊次数（如 1～2 次），避免无限扩展开销。

2. **专家角色（Persona）定义**
   - 配置化：`Config.research.expertCouncil` 或 `folder/.research/experts.yaml`。
   - 每个专家包含：`id`、`displayName`（真实领域名人/化名）、`domain`、`signatureWorks`（著名教材/方法论，如 *《xxx》* 第 y 章、某经典框架名）、`stance`（保守/激进、偏工程/偏理论）、`systemPrompt` 模板片段。
   - 示例角色类型（按任务主题自动选 2～3 个，非写死）：「时序预测 + 稳健评估」学者、「梯度提升 / 表格数据」专家、「竞赛策略与 ablation 设计」教练——具体名单由 `goal` 标签或用户配置决定。

3. **运行时形态**
   - Orchestrator 为每位专家创建**短时合成 binding**（类似现有 `research:researcher`，如 `research:expert:<id>`），各自独立 `sessionId`，**不**占用主 Researcher 的长上下文。
   - Researcher 提交「求救包」：当前计划摘要、B 的最新 advice、已失败尝试列表、可选知识库片段。
   - 专家并行或串行短答（每专家 1 轮，无工具或只读工具），输出：`诊断`、`可采纳的具体改法`、`需避免的坑`。
   - Researcher 汇总为 `## Expert Council Notes` 后进入下一轮 plan / complete，B 评审时可见该附录。

4. **与 Reviewer 的关系**
   - B 仍是**唯一** `confirm-complete` 裁决者；专家只给建议，不替代 B。
   - B 的 prompt 可提示：若存在 Expert Council 输出，需评估 Researcher 是否**实质性**采纳，而非堆砌引用。

5. **可观测性**
   - Transcript 增加 `kind: expert-consult`；Telegram 推送 `[expert:姓名]` 摘要。
   - `state.json` 记录 `expertCouncilTriggeredAt`、`expertsInvoked[]`。

6. **边界与成本**
   - 专家实例可用更便宜/更快的 runner（配置与 A/B 分离），会诊总 token 设硬上限。
   - 名人角色仅作**方法论与人格锚点**，需在 prompt 中声明「模拟视角、非真实人物发言」；避免误导或版权争议（可用「以其经典方法论为锚的专家 persona」表述）。

**与主题知识库的关系：** 会诊时优先从 Topic KB 检索「赛题硬约束」「历史失败模式」注入求救包；专家 prompt 引用 KB 中的规则条目编号，便于 B 交叉验证。

---
name: Agent-IM Console System
colors:
  primary: "#e8eaed"
  secondary: "#9aa3af"
  tertiary: "#6b7280"
  accent: "#6d9eff"
  neutral: "#12141a"
typography:
  h1: "text-xl→2xl, semibold, tight leading, pretty wrap"
  body: "14–15px / 1.55, relaxed scan for forms and tables"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
rounded:
  sm: "8px"
  md: "12px"
---

## Overview

面向本地运维与 Kanban 管控的控制台界面：深色中性底、单层强调色、高密度可读。受众为开发者；语气冷静、信息优先，避免营销化装饰。

## Colors

- **primary**：主正文与标题，保证与背景的对比度。
- **secondary / tertiary**：辅助说明、表头、占位；不用于可点击主行动。
- **accent**：唯一强调色，用于链接、焦点环、选中 Tab、关键数据锚点；禁止多条霓虹色并存。
- **neutral**：卡片与抬升表面；与画布背景拉开一级即可，忌强阴影堆叠。
- **语义**：成功/警告/危险使用低饱和面色块 + 清晰边框，不用刺眼纯色铺满。

## Typography

- 中文使用 Noto Sans SC（经 Next.js 字体注入），西文与数字同族协调。
- 标题级数不超过两级露出；`h1` 页面唯一，`h2` 分区。
- 代码与 ID 使用 `ui-monospace`；正文字号 14–15px，表格与表单标签 12–13px。
- 长标题使用 `text-wrap: balance`（或 pretty）减少孤立词。

## Layout

- 画布最大宽度随页面：`ui-board-fluid` 铺满，`page-shell` 统一水平内边距与垂直节奏。
- 分区间距以 16–24px 阶梯递进；表单多列 `auto-fit` 最小列宽 ≥220px。
- 触控目标 ≥44px（按钮与导航项 padding 兜底）。
- 响应式：窄屏导航自动折行；表格横向滚动容器包裹。

## Components

- **page-shell**：页面根容器，背景与默认文字色。
- **hero-card / ui-panel**：一级容器，细边框 + 轻背景；忌厚重投影。
- **ui-nav**：文本型导航或低调胶囊；当前页可用边框或底色区分。
- **ui-btn**：`primary` / `secondary` / `ghost` / `danger`；统一圆角与 transition。
- **ui-field / ui-input**：标签在上，控件全宽；`focus-visible` 轮廓与 accent 对齐。
- **ui-banner**：全局反馈；警告与错误变体分开。
- **ui-table / ui-kanban**：表格浅色分割线；看板列为独立 surface。
- **ui-stack**：纵向排列块级内容（列方向 flex + 统一 gap），用于嵌套卡片等。
- **ui-btn-sm**：与 `ui-btn` 联用的小号按钮（更小 padding / 字号）。
- **扩展工具类**：监控页 `ui-monitor-*`、桥接说明 `ui-bridge-intro-*`、环境检测 `ui-env-*`、弹层 `ui-modal-*` 等均定义在 `globals.css`，与 `--color-*` 令牌一致。

## Do's and Don'ts

- **Do** 用 CSS 变量集中令牌，页面层少写一次性十六进制。
- **Do** 交互状态依赖 `:focus-visible`、hover transition（约 0.15s）。
- **Don't** 使用大面积霓虹渐变、漂浮光斑、无意义插图。
- **Don't** 用 emoji 代替状态语义（改用标签文案或色点）。
- **Don't** 在同一屏拼接多种强调色（保留 accent + 语义色即可）。

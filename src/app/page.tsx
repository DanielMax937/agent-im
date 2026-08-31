const platformEndpoints = [
  'GET /health',
  'GET /api/skills/catalog',
  'GET /api/projects',
  'GET /api/projects/:projectId/next-issue-id',
  'GET /api/projects/:projectId/kanban-roles',
  'PUT /api/projects/:projectId/kanban-roles',
  'GET /api/platform/runners',
  'POST /api/projects',
  'DELETE /api/projects/:projectId',
  'GET /api/sprints',
  'GET /api/tasks',
  'GET /api/instances',
  'GET /api/approvals',
  'POST /api/workflows/sprints/start',
  'POST /api/workflows/tasks/assign',
];

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero-card" aria-labelledby="home-title">
        <p className="eyebrow">agent-im</p>
        <h1 id="home-title">基于 Next.js 的 DevOps 智能体平台</h1>
        <p className="lead">
          Web 由 Next.js 承载；平台 API、Kanban 与多实例运行器通过统一 HTTP 暴露，便于集成。
        </p>
        <nav className="actions" aria-label="主要入口">
          <a href="/admin">管理后台</a>
          <a href="/projects">项目管理</a>
          <a href="/board">任务看板</a>
          <a href="/health">健康检查</a>
          <a href="/api/bridge/status">桥接状态 JSON</a>
        </nav>
      </section>

      <div className="grid">
        <article className="panel">
          <h2>技术栈</h2>
          <ul>
            <li>Next.js App Router（页面与 API）</li>
            <li>Pino 结构化日志与脱敏</li>
            <li>核心逻辑在 <code>src/platform</code>，与 UI 解耦</li>
          </ul>
        </article>

        <article className="panel">
          <h2>常用 API</h2>
          <ul>
            {platformEndpoints.map((endpoint) => (
              <li key={endpoint}>
                <code className="ui-mono ui-mono-12">
                  {endpoint}
                </code>
              </li>
            ))}
          </ul>
        </article>
      </div>
    </main>
  );
}

const platformEndpoints = [
  'GET /health',
  'GET /api/projects',
  'GET /api/sprints',
  'GET /api/tasks',
  'GET /api/instances',
  'GET /api/approvals',
  'POST /api/workflows/sprints/start',
  'POST /api/workflows/tasks/assign',
  'POST /api/webhooks/jira',
];

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">agent-im</p>
        <h1>Next.js DevOps Agentic Platform</h1>
        <p className="lead">
          The web server now runs on Next.js, while the platform APIs, Jira workflow engine,
          and multi-instance agent manager stay reusable behind native HTTP handlers.
        </p>
        <div className="actions">
          <a href="/health">Open health endpoint</a>
          <a href="/api/bridge/status">Open bridge status</a>
        </div>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Server stack</h2>
          <ul>
            <li>Next.js app router for web and API routes</li>
            <li>Pino-backed structured logging with secret masking</li>
            <li>Shared workflow and instance services under `src/platform`</li>
          </ul>
        </article>

        <article className="panel">
          <h2>Key endpoints</h2>
          <ul>
            {platformEndpoints.map((endpoint) => (
              <li key={endpoint}>{endpoint}</li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}

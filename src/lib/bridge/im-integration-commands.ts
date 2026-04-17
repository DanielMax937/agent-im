/**
 * Optional IM slash commands: blog2media job enqueue + article-writer spawn.
 * Env:
 *   BLOG2MEDIA_BASE_URL or CTI_BLOG2MEDIA_BASE_URL — default http://127.0.0.1:9300
 *   ARTICLE_WRITER_HOME or CTI_ARTICLE_WRITER_HOME — absolute path to article-writer repo (required for /article_*)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { escapeHtml } from './adapters/telegram-utils';
import { getLogger } from '../../logger';

const DEFAULT_BLOG2MEDIA_BASE = 'http://127.0.0.1:9300';
const MAX_TOPIC_LEN = 12_000;
const FETCH_TIMEOUT_MS = 60_000;

export function resolveBlog2mediaBaseUrl(): string {
  const raw =
    process.env.BLOG2MEDIA_BASE_URL?.trim() ||
    process.env.CTI_BLOG2MEDIA_BASE_URL?.trim() ||
    DEFAULT_BLOG2MEDIA_BASE;
  return raw.replace(/\/+$/, '');
}

export function resolveArticleWriterHome(): string {
  return (
    process.env.ARTICLE_WRITER_HOME?.trim() || process.env.CTI_ARTICLE_WRITER_HOME?.trim() || ''
  );
}

/** Accept only http(s) URLs for optional blog2media `url` (same contract as POST body). */
export function validateOptionalHttpUrlForIntegration(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.length > 8192) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function postBlog2mediaJob(params: {
  endpoint: 'rednote' | 'medium';
  url?: string;
}): Promise<string> {
  const base = resolveBlog2mediaBaseUrl();
  const targetUrl = `${base}/api/${params.endpoint}`;
  const body: Record<string, string> = {};
  if (params.url) body.url = params.url;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      `<b>${params.endpoint}</b> request failed`,
      '',
      `Base: <code>${escapeHtml(base)}</code>`,
      escapeHtml(msg),
    ].join('\n');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return [
      `<b>${params.endpoint}</b> unexpected response`,
      `HTTP ${res.status}`,
      escapeHtml(text.slice(0, 500)),
    ].join('\n');
  }

  const obj = payload as Record<string, unknown>;
  if (res.status === 202 && typeof obj.jobId === 'string') {
    const lines = [
      `<b>${params.endpoint}</b> job queued`,
      `jobId: <code>${escapeHtml(obj.jobId)}</code>`,
    ];
    if (params.url) {
      lines.push(`url: ${escapeHtml(params.url)}`);
    }
    lines.push(
      '',
      `Poll: <code>${escapeHtml(`${base}/api/${params.endpoint}/${obj.jobId}`)}</code>`,
    );
    return lines.join('\n');
  }

  const err =
    typeof obj.error === 'string'
      ? obj.error
      : !res.ok
        ? `HTTP ${res.status}`
        : 'enqueue failed';
  return [
    `<b>${params.endpoint}</b> failed`,
    escapeHtml(err),
    params.url ? `url: ${escapeHtml(params.url)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function spawnArticleWriterFromBot(params: {
  profile: 'zh' | 'en';
  topic: string;
}): string {
  const home = resolveArticleWriterHome();
  if (!home) {
    return [
      '<b>article-writer</b> not configured',
      '',
      'Set <code>ARTICLE_WRITER_HOME</code> (or <code>CTI_ARTICLE_WRITER_HOME</code>) to the article-writer repo path.',
    ].join('\n');
  }

  if (!fs.existsSync(home)) {
    return `article-writer home does not exist: <code>${escapeHtml(home)}</code>`;
  }

  const topic = params.topic.trim();
  if (!topic) {
    return 'Usage: <code>/article_zh &lt;topic&gt;</code> or <code>/article_en &lt;topic&gt;</code>';
  }
  if (topic.length > MAX_TOPIC_LEN) {
    return `Topic too long (max ${MAX_TOPIC_LEN} characters).`;
  }

  const target = params.profile === 'zh' ? 'dailaosan' : 'potter';
  const language = params.profile === 'zh' ? 'zh' : 'en';

  const args = [
    'run',
    'article-writer',
    '--auto',
    '--target',
    target,
    '--language',
    language,
    topic,
  ];

  try {
    const child = spawn('uv', args, {
      cwd: home,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', (err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), home },
        '[bridge] article-writer spawn error',
      );
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [`Failed to start <code>uv run article-writer</code>`, escapeHtml(msg)].join('\n');
  }

  const label =
    params.profile === 'zh'
      ? '中文 / 饭统戴老板 (dailaosan)'
      : 'English / Brian Potter (potter)';

  return [
    '<b>article-writer</b> started in background',
    '',
    `Profile: ${escapeHtml(label)}`,
    `CWD: <code>${escapeHtml(home)}</code>`,
    `Topic: ${escapeHtml(topic)}`,
  ].join('\n');
}

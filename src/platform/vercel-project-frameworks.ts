import type { Project } from './types';

/**
 * Vercel REST API `framework` enum for `PATCH /v9/projects` (see Vercel API reference).
 * Keep in sync with platform updates; bootstrap LLM must return exactly one of these slugs.
 */
export const VERCEL_API_FRAMEWORK_SLUGS = [
  'services',
  'blitzjs',
  'nextjs',
  'gatsby',
  'remix',
  'react-router',
  'astro',
  'hexo',
  'eleventy',
  'docusaurus-2',
  'docusaurus',
  'preact',
  'solidstart-1',
  'solidstart',
  'dojo',
  'ember',
  'vue',
  'scully',
  'ionic-angular',
  'angular',
  'polymer',
  'svelte',
  'sveltekit',
  'sveltekit-1',
  'ionic-react',
  'create-react-app',
  'gridsome',
  'umijs',
  'sapper',
  'saber',
  'stencil',
  'nuxtjs',
  'redwoodjs',
  'hugo',
  'jekyll',
  'brunch',
  'middleman',
  'zola',
  'hydrogen',
  'vite',
  'tanstack-start',
  'vitepress',
  'vuepress',
  'parcel',
  'fastapi',
  'flask',
  'fasthtml',
  'django',
  'sanity-v3',
  'sanity',
  'storybook',
  'nitro',
  'hono',
  'express',
  'h3',
  'koa',
  'nestjs',
  'elysia',
  'fastify',
  'xmcp',
  'python',
  'ruby',
  'rust',
  'axum',
  'actix-web',
  'node',
  'go',
  'mastra',
] as const;

export type VercelApiFrameworkSlug = (typeof VERCEL_API_FRAMEWORK_SLUGS)[number];

const SLUG_SET = new Set<string>(VERCEL_API_FRAMEWORK_SLUGS);

/** Typical Node frontend stacks where default Jest/json-summary coverage paths are reasonable. */
const JS_FRONTEND_COVERAGE_SLUGS = new Set<string>([
  'nextjs',
  'remix',
  'nuxtjs',
  'sveltekit',
  'sveltekit-1',
  'astro',
  'vite',
  'tanstack-start',
  'create-react-app',
  'gatsby',
  'redwoodjs',
  'blitzjs',
  'react-router',
  'solidstart',
  'solidstart-1',
  'ember',
  'vue',
  'angular',
  'preact',
  'svelte',
  'hydrogen',
  'parcel',
]);

export function assertVercelApiFrameworkSlug(value: string): asserts value is VercelApiFrameworkSlug {
  const v = value.trim();
  if (!v || !SLUG_SET.has(v)) {
    throw new Error(
      `Invalid Vercel framework slug "${value}". Must be one of the supported API values (see VERCEL_API_FRAMEWORK_SLUGS).`,
    );
  }
}

export function isVercelApiFrameworkSlug(value: string): value is VercelApiFrameworkSlug {
  return Boolean(value.trim()) && SLUG_SET.has(value.trim());
}

export function formatVercelFrameworkSlugListForLlm(): string {
  return VERCEL_API_FRAMEWORK_SLUGS.join('\n');
}

export function coverageDefaultsForVercelFramework(
  slug: string,
): Partial<Pick<Project, 'coverageCommand' | 'coverageSummaryPath'>> {
  const s = slug.trim();
  if (!s || !JS_FRONTEND_COVERAGE_SLUGS.has(s)) return {};
  return {
    coverageCommand: 'npm test -- --coverage --coverageReporters=json-summary',
    coverageSummaryPath: 'coverage/coverage-summary.json',
  };
}

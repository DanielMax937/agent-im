import * as esbuild from 'esbuild';

const sharedConfig = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    'discord.js',
    '@larksuiteoapi/node-sdk',
    'ws',
    'markdown-it',
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
};

await esbuild.build({
  ...sharedConfig,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/daemon.mjs',
});

console.log('Built dist/daemon.mjs');

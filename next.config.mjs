/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    '@discordjs/ws',
    '@larksuiteoapi/node-sdk',
    'bufferutil',
    'discord.js',
    'erlpack',
    'markdown-it',
    'redis',
    'utf-8-validate',
    'ws',
    'zlib-sync',
  ],
};

export default nextConfig;

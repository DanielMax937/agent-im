import { CopilotProvider } from '../src/copilot-provider.ts';

async function main(): Promise<void> {
  const prompt = process.argv[2] || 'hi';
  const workingDirectory = process.argv[3] || process.cwd();
  const model = process.argv[4] || 'gpt-5.3-codex';

  const provider = new CopilotProvider(undefined, { autoApprove: true });
  const startedAt = Date.now();
  const stream = provider.streamChat({
    prompt,
    sessionId: `debug-${Date.now()}`,
    workingDirectory,
    model,
  });

  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(`[${Date.now() - startedAt}ms] ${value}`);
  }

  process.stdout.write(`DONE ${Date.now() - startedAt}ms\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

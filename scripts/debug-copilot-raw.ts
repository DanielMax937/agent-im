import { spawn } from 'node:child_process';

async function main(): Promise<void> {
  const prompt = process.argv[2] || 'hi';
  const workingDirectory = process.argv[3] || process.cwd();
  const model = process.argv[4] || 'gpt-5.3-codex';

  const child = spawn(
    'copilot',
    [
      '--output-format', 'json',
      '--stream', 'on',
      '--yolo',
      '--add-dir', workingDirectory,
      '--model', model,
      '-p', prompt,
    ],
    {
      cwd: workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  child.stdin.end();

  const startedAt = Date.now();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[stdout ${Date.now() - startedAt}ms] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stdout.write(`[stderr ${Date.now() - startedAt}ms] ${chunk}`);
  });

  await new Promise<void>((resolve, reject) => {
    child.on('close', (code, signal) => {
      process.stdout.write(`\n[CLOSE ${Date.now() - startedAt}ms] code=${code} signal=${signal}\n`);
      resolve();
    });
    child.on('error', reject);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

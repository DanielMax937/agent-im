import { spawn } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string, allowedExitCodes?: number[]): Promise<CommandResult>;
}

class ShellCommandRunner implements CommandRunner {
  async run(command: string, args: string[], cwd: string, allowedExitCodes: number[] = [0]): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', reject);
      child.on('close', (code) => {
        const exitCode = code ?? 1;
        const result = { stdout, stderr, exitCode };
        if (!allowedExitCodes.includes(exitCode)) {
          reject(new Error(`${command} ${args.join(' ')} failed (${exitCode}): ${stderr || stdout}`));
          return;
        }
        resolve(result);
      });
    });
  }
}

export interface CreateBranchInput {
  repoPath: string;
  baseBranch: string;
  nextBranch: string;
}

export interface CommitChangesInput {
  repoPath: string;
  message: string;
}

export class GitService {
  constructor(private readonly runner: CommandRunner = new ShellCommandRunner()) {}

  async createSprintBranch(input: CreateBranchInput): Promise<string> {
    await this.runGit(input.repoPath, ['fetch', 'origin', input.baseBranch]);
    await this.runGit(input.repoPath, ['checkout', input.baseBranch]);
    await this.runGit(input.repoPath, ['pull', 'origin', input.baseBranch]);
    await this.runGit(input.repoPath, ['checkout', '-B', input.nextBranch, input.baseBranch]);
    return input.nextBranch;
  }

  async createTaskBranch(input: CreateBranchInput): Promise<string> {
    await this.runGit(input.repoPath, ['fetch', 'origin', input.baseBranch]);
    await this.runGit(input.repoPath, ['checkout', input.baseBranch]);
    await this.runGit(input.repoPath, ['checkout', '-B', input.nextBranch, input.baseBranch]);
    return input.nextBranch;
  }

  async commitAll(input: CommitChangesInput): Promise<{ committed: boolean }> {
    await this.runGit(input.repoPath, ['add', '.']);
    const diffResult = await this.runGit(
      input.repoPath,
      ['diff', '--cached', '--quiet'],
      [0, 1],
    );

    if (diffResult.exitCode === 0) {
      return { committed: false };
    }

    await this.runGit(input.repoPath, ['commit', '-m', input.message]);
    return { committed: true };
  }

  async pushBranch(repoPath: string, branchName: string): Promise<void> {
    await this.runGit(repoPath, ['push', '-u', 'origin', branchName]);
  }

  async getHeadSha(repoPath: string): Promise<string> {
    const result = await this.runGit(repoPath, ['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  private runGit(repoPath: string, args: string[], allowedExitCodes?: number[]): Promise<CommandResult> {
    return this.runner.run('git', args, repoPath, allowedExitCodes);
  }
}

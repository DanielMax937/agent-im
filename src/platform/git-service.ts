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

  /**
   * Adds a linked worktree for isolated developer work.
   * When `CTI_KANBAN_USE_WORKTREE=1`, WorkflowService uses this for new dev assignments.
   */
  async createTaskWorktree(input: {
    repoPath: string;
    baseBranch: string;
    worktreePath: string;
    branchName: string;
  }): Promise<void> {
    await this.runGit(input.repoPath, ['fetch', 'origin', input.baseBranch]);
    await this.runGit(input.repoPath, [
      'worktree',
      'add',
      '-B',
      input.branchName,
      input.worktreePath,
      input.baseBranch,
    ]);
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

  /** `git fetch origin` — updates remote refs before comparing regression baseline to master. */
  async fetchOrigin(repoPath: string): Promise<void> {
    await this.runGit(repoPath, ['fetch', 'origin']);
  }

  /** Resolves a ref such as `origin/master` to a full SHA. */
  async resolveRefSha(repoPath: string, ref: string): Promise<string> {
    const result = await this.runGit(repoPath, ['rev-parse', ref]);
    return result.stdout.trim();
  }

  private runGit(repoPath: string, args: string[], allowedExitCodes?: number[]): Promise<CommandResult> {
    return this.runner.run('git', args, repoPath, allowedExitCodes);
  }
}

import { spawn } from 'node:child_process';
import path from 'node:path';

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

function pathParts(p: string): string[] {
  return p.split(PATH_SEP).filter(Boolean);
}

function prependPathDir(env: NodeJS.ProcessEnv, dir: string): void {
  const parts = pathParts(env.PATH ?? '');
  if (parts.includes(dir)) return;
  env.PATH = parts.length ? `${dir}${PATH_SEP}${parts.join(PATH_SEP)}` : dir;
}

/**
 * Child env for git. Optional `CTI_GIT_EXECUTABLE` → prepend that file's directory to `PATH`.
 * On macOS, merge standard dirs at the front (deduped) so subprocesses behave like a login shell.
 */
function envForPlatformCli(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  const gitExe = process.env.CTI_GIT_EXECUTABLE?.trim();
  if (gitExe && (gitExe.includes('/') || gitExe.includes('\\'))) {
    prependPathDir(env, path.dirname(path.resolve(gitExe)));
  }

  if (process.platform === 'darwin') {
    const std = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const existing = pathParts(env.PATH ?? '');
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const d of [...std, ...existing]) {
      if (seen.has(d)) continue;
      seen.add(d);
      merged.push(d);
    }
    env.PATH = merged.join(':');
  }

  return env;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkingTreeStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  raw: string;
}

export interface CheckoutOriginTrackingBranchResult {
  discardedEntries: WorkingTreeStatusEntry[];
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string, allowedExitCodes?: number[]): Promise<CommandResult>;
}

class ShellCommandRunner implements CommandRunner {
  async run(command: string, args: string[], cwd: string, allowedExitCodes: number[] = [0]): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: envForPlatformCli(),
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
    await this.pushBranch(input.repoPath, input.nextBranch);
    return input.nextBranch;
  }

  async createTaskBranch(input: CreateBranchInput): Promise<string> {
    // Sprint branches (e.g. feature/sprint1) often exist only locally after `startSprint`;
    // `git fetch origin <branch>` fails if that ref was never pushed. Refresh remotes, then use local base.
    await this.runGit(input.repoPath, ['fetch', 'origin']);
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
    await this.runGit(input.repoPath, ['fetch', 'origin']);
    await this.runGit(input.repoPath, [
      'worktree',
      'add',
      '-B',
      input.branchName,
      input.worktreePath,
      input.baseBranch,
    ]);
  }

  /**
   * Unregisters a linked worktree and deletes its directory. Run from the **main** repo (`repoPath`).
   * `--force` drops uncommitted/untracked changes in that worktree so removal always succeeds when possible.
   */
  async removeTaskWorktree(repoPath: string, worktreePath: string): Promise<void> {
    const wt = worktreePath.trim();
    if (!wt) return;
    await this.runGit(repoPath, ['worktree', 'remove', '--force', wt]);
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

  async getWorkingTreeStatus(repoPath: string): Promise<WorkingTreeStatusEntry[]> {
    const result = await this.runGit(repoPath, ['status', '--short']);
    return result.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const normalized = line.startsWith('??') ? `?? ${line.slice(2).trimStart()}` : line;
        const indexStatus = normalized.slice(0, 1);
        const worktreeStatus = normalized.slice(1, 2);
        const path = normalized.slice(3).trim();
        return {
          path,
          indexStatus,
          worktreeStatus,
          raw: normalized,
        };
      });
  }

  /**
   * Checkout local branch tracking `origin/<branch>` (e.g. main/master) after fetch.
   * Used for final regression testing on the integration branch in the main repo clone.
   */
  async checkoutOriginTrackingBranch(repoPath: string, branch: string): Promise<CheckoutOriginTrackingBranchResult> {
    const dirtyEntries = await this.getWorkingTreeStatus(repoPath);
    await this.runGit(repoPath, ['fetch', 'origin', branch]);
    await this.runGit(repoPath, ['checkout', branch]);
    if (dirtyEntries.length > 0) {
      await this.runGit(repoPath, ['reset', '--hard', `origin/${branch}`]);
      await this.runGit(repoPath, ['clean', '-fd']);
    } else {
      await this.runGit(repoPath, ['pull', '--ff-only', 'origin', branch]);
    }
    return { discardedEntries: dirtyEntries };
  }

  private runGit(repoPath: string, args: string[], allowedExitCodes?: number[]): Promise<CommandResult> {
    return this.runner.run('git', args, repoPath, allowedExitCodes);
  }
}

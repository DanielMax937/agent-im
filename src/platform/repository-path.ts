/**
 * `ProjectRepository.localPath` must be a filesystem directory (the cloned repo root).
 * Remote URLs (SSH/HTTPS) belong in `remoteUrl`, not `localPath`.
 */
export function looksLikeRemoteRepositoryUrl(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^git@[^:]+:/.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^ssh:\/\//i.test(t)) return true;
  return false;
}

export const LOCAL_REPOSITORY_PATH_HINT =
  '「本地路径」须为本机已克隆的仓库目录（例如 /Users/you/todolist），不能填 git@… 或 https://…；远程地址请填在「远程仓库 URL」';

export function assertValidLocalRepositoryPath(localPath: string): void {
  const t = localPath.trim();
  if (!t) return;
  if (looksLikeRemoteRepositoryUrl(t)) {
    throw new Error(`repository.localPath 无效：${LOCAL_REPOSITORY_PATH_HINT}`);
  }
}

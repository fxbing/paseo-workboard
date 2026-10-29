import { execFile, type ExecFileException } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);

/** Read only: never fetch, stash, commit, push, or remove a worktree. */
export async function checkGitSafety(
  directory: string,
  isGit: boolean,
): Promise<string | null> {
  try {
    if (!isAbsolute(directory) || !(await stat(directory)).isDirectory())
      return "directory-unavailable";
  } catch {
    return "directory-unavailable";
  }
  const git = async (...args: string[]) =>
    (
      await execute("git", ["-C", directory, ...args], {
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          // Git has no distinct exit code for failed repository discovery.
          LC_ALL: "C",
          LANGUAGE: "C",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      })
    ).stdout.trim();
  try {
    try {
      await git("rev-parse", "--show-toplevel");
    } catch (error) {
      const failure = error as ExecFileException | null;
      const stderr = failure?.stderr?.trim();
      if (
        isGit ||
        failure?.code !== 128 ||
        failure.killed ||
        failure.signal ||
        (stderr !==
          "fatal: not a git repository (or any of the parent directories): .git" &&
          !/^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.$/.test(
            stderr ?? "",
          ))
      )
        return "git-unknown";
      // Git may report missing repositories for unreadable metadata as well.
      // Reject markers and unreadable ancestors instead of treating them as absent.
      let current = await realpath(directory);
      for (;;) {
        const entries = await readdir(current);
        if (
          entries.includes(".git") ||
          ["HEAD", "objects", "refs"].every((name) => entries.includes(name))
        )
          return "git-unknown";
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
      }
    }
    if (await git("status", "--porcelain=v1", "--untracked-files=all"))
      return "git-dirty";
    let branch: string;
    try {
      branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
    } catch {
      return "git-detached";
    }
    let remote: string;
    let merge: string;
    try {
      await git("rev-parse", "--verify", "@{upstream}");
      remote = await git("config", `branch.${branch}.remote`);
      merge = await git("config", `branch.${branch}.merge`);
    } catch {
      return "git-no-upstream";
    }
    if (remote === ".") return "git-no-upstream";
    if (Number(await git("rev-list", "--count", "@{upstream}..HEAD")) > 0)
      return "git-unpushed";
    // A stale tracking ref is insufficient evidence that the branch still exists remotely.
    const remoteTip = (
      await git("ls-remote", "--exit-code", remote, merge)
    ).split(/\s/)[0];
    if (remoteTip !== (await git("rev-parse", "@{upstream}")))
      return "git-unknown";
    return null;
  } catch {
    return "git-unknown";
  }
}

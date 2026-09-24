import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      })
    ).stdout.trim();
  try {
    try {
      await git("rev-parse", "--show-toplevel");
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error
          ? String(error.stderr)
          : "";
      return !isGit && stderr.includes("not a git repository")
        ? null
        : "git-unknown";
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

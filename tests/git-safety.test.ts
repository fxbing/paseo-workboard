import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkGitSafety } from "../server/git-safety";

it("protects real dirty/untracked/unpushed Git work and requires an upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "workboard-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Workboard fixture");
    git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "a"), "initial\n");
    git("add", "a");
    git("commit", "-m", "initial");
    expect(await checkGitSafety(root, true)).toBe("git-no-upstream");
    const remote = await mkdtemp(join(tmpdir(), "workboard-remote-"));
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      git("remote", "add", "origin", remote);
      git("push", "-u", "origin", "main");
      expect(await checkGitSafety(root, true)).toBeNull();
      await writeFile(join(root, "new"), "keep me\n");
      expect(await checkGitSafety(root, true)).toBe("git-dirty");
      git("add", "new");
      git("commit", "-m", "unpushed");
      expect(await checkGitSafety(root, true)).toBe("git-unpushed");
      git("push");
      git("checkout", "--detach");
      expect(await checkGitSafety(root, true)).toBe("git-detached");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("allows an existing non-Git directory but not a missing directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workboard-nongit-"));
  try {
    expect(await checkGitSafety(dir, false)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(await checkGitSafety(dir, false)).toBe("directory-unavailable");
});

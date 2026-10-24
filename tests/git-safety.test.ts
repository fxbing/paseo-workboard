import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkGitSafety } from "../server/git-safety";
import { isolatedGitEnvironment } from "./git-environment";

it("protects real dirty/untracked/unpushed Git work and requires an upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "workboard-git-"));
  const originalEnv = process.env;
  const template = join(root, "empty-template");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    await mkdir(template);
    process.env = isolatedGitEnvironment(template);
    git("init", "-b", "main");
    const poisonedConfig = join(root, ".git", "poisoned-global-config");
    const badHooks = join(root, ".git", "bad-hooks");
    await mkdir(badHooks);
    await writeFile(join(badHooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const poisonedIgnore = join(root, ".git", "poisoned-ignore");
    await writeFile(poisonedIgnore, "new\n");
    git("config", "--file", poisonedConfig, "commit.gpgSign", "true");
    git(
      "config",
      "--file",
      poisonedConfig,
      "gpg.program",
      join(root, ".git", "missing-gpg"),
    );
    git("config", "--file", poisonedConfig, "core.hooksPath", badHooks);
    git(
      "config",
      "--file",
      poisonedConfig,
      "core.excludesFile",
      poisonedIgnore,
    );
    process.env = {
      ...isolatedGitEnvironment(template),
      GIT_CONFIG_GLOBAL: poisonedConfig,
      GIT_CONFIG_COUNT: "0",
    };
    expect(git("config", "--get", "core.hooksPath").trim()).toBe(badHooks);
    process.env = isolatedGitEnvironment(template);
    expect(git("config", "--get", "core.hooksPath").trim()).toBe(template);
    expect(git("config", "--get", "core.excludesFile").trim()).toBe(
      join(template, "disabled-config"),
    );
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
    process.env = originalEnv;
    await rm(root, { recursive: true, force: true });
  }
});
it("allows an existing non-Git directory but not a missing directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workboard-nongit-"));
  const originalEnv = process.env;
  try {
    process.env = isolatedGitEnvironment(dir);
    expect(await checkGitSafety(dir, false)).toBeNull();
    await rm(dir, { recursive: true, force: true });
    expect(await checkGitSafety(dir, false)).toBe("directory-unavailable");
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

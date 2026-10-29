import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkGitSafety } from "../server/git-safety";
import { isolatedGitEnvironment } from "./git-environment";

// This fixture starts many real Git processes, which can exceed 5 seconds on Windows.
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
    expect(await checkGitSafety(root, false)).toBe("git-no-upstream");
    const remote = await mkdtemp(join(tmpdir(), "workboard-remote-"));
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      git("remote", "add", "origin", remote);
      git("push", "-u", "origin", "main");
      expect(await checkGitSafety(root, true)).toBeNull();
      const child = join(root, "child");
      await mkdir(child);
      expect(await checkGitSafety(child, true)).toBeNull();
      await writeFile(join(root, "new"), "keep me\n");
      expect(await checkGitSafety(root, true)).toBe("git-dirty");
      const decoy = await mkdtemp(join(tmpdir(), "workboard-git-context-"));
      const environment = process.env;
      try {
        execFileSync("git", ["clone", "--branch", "main", remote, decoy], {
          stdio: "ignore",
        });
        expect(await checkGitSafety(decoy, true)).toBeNull();
        for (const context of [
          { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy },
          {
            GIT_DIR: join(decoy, ".git"),
            GIT_WORK_TREE: decoy,
            GIT_COMMON_DIR: join(decoy, ".git"),
            GIT_INDEX_FILE: join(decoy, ".git", "index"),
          },
        ]) {
          process.env = { ...environment, ...context };
          expect(await checkGitSafety(root, true)).toBe("git-dirty");
        }
        process.env = environment;
        git("config", "core.worktree", decoy);
        try {
          expect(await checkGitSafety(root, true)).toBe("git-unknown");
        } finally {
          git("config", "--unset", "core.worktree");
        }
      } finally {
        process.env = environment;
        await rm(decoy, { recursive: true, force: true });
      }
      git("add", "new");
      git("commit", "-m", "unpushed");
      expect(await checkGitSafety(root, true)).toBe("git-unpushed");
      const environmentBeforeGraph = process.env;
      const graft = join(root, ".git", "ambient-graft");
      await writeFile(
        graft,
        `${git("rev-parse", "@{upstream}").trim()} ${git("rev-parse", "HEAD").trim()}\n`,
      );
      try {
        process.env = { ...environmentBeforeGraph, GIT_GRAFT_FILE: graft };
        expect(await checkGitSafety(root, true)).toBe("git-unpushed");
      } finally {
        process.env = environmentBeforeGraph;
      }
      git("branch", "local-base");
      git("config", "branch.main.remote", ".");
      git("config", "branch.main.merge", "refs/heads/local-base");
      expect(await checkGitSafety(root, true)).toBe("git-no-upstream");
      const config = join(root, ".git", "ambient-config");
      git("config", "--file", config, "branch.main.remote", root);
      git(
        "config",
        "--file",
        config,
        "branch.main.merge",
        "refs/heads/local-base",
      );
      try {
        process.env = { ...environmentBeforeGraph, GIT_CONFIG: config };
        expect(await checkGitSafety(root, true)).toBe("git-no-upstream");
      } finally {
        process.env = environmentBeforeGraph;
      }
      git("branch", "--set-upstream-to=origin/main", "main");
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
}, 30_000);
it.each(["C", "zh_CN.UTF-8", "de_DE.UTF-8"])(
  "checks real non-Git and missing directories under %s",
  async (locale) => {
    const dir = await mkdtemp(join(tmpdir(), "workboard-nongit-"));
    const originalEnv = process.env;
    try {
      process.env = {
        ...isolatedGitEnvironment(dir),
        LANG: locale,
        LC_ALL: locale,
        LANGUAGE: locale,
      };
      expect(await checkGitSafety(dir, false)).toBeNull();
      expect(await checkGitSafety(dir, true)).toBe("git-unknown");
      expect(await checkGitSafety("relative-directory", false)).toBe(
        "directory-unavailable",
      );
      const file = join(dir, "file");
      await writeFile(file, "not a directory");
      expect(await checkGitSafety(file, false)).toBe("directory-unavailable");
      await rm(dir, { recursive: true, force: true });
      expect(await checkGitSafety(dir, false)).toBe("directory-unavailable");
    } finally {
      process.env = originalEnv;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(["invalid gitfile", "bare repository", "missing executable"])(
  "rejects a real %s even for a non-Git project",
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "workboard-git-failure-"));
    const originalEnv = process.env;
    try {
      process.env = isolatedGitEnvironment(dir);
      if (kind === "invalid gitfile") {
        await writeFile(join(dir, ".git"), `gitdir: ${join(dir, "missing")}\n`);
      } else if (kind === "bare repository") {
        execFileSync("git", ["init", "--bare", dir], { stdio: "ignore" });
      } else {
        process.env = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)),
          ),
          PATH: "",
        };
      }
      expect(await checkGitSafety(dir, false)).toBe("git-unknown");
    } finally {
      process.env = originalEnv;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "rejects unreadable Git metadata through direct, child and symlink paths",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "workboard-git-permissions-"));
    const originalEnv = process.env;
    const repo = join(root, "repo");
    const metadata = join(repo, ".git");
    try {
      process.env = isolatedGitEnvironment(root);
      execFileSync("git", ["init", repo], { stdio: "ignore" });
      const child = join(repo, "child");
      const link = join(root, "link");
      await mkdir(child);
      await symlink(child, link);
      await chmod(metadata, 0);
      for (const directory of [repo, child, link])
        expect(await checkGitSafety(directory, false)).toBe("git-unknown");
    } finally {
      process.env = originalEnv;
      await chmod(metadata, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "rejects a non-Git directory when its ancestor cannot be inspected",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "workboard-git-ancestor-"));
    const originalEnv = process.env;
    try {
      process.env = isolatedGitEnvironment(root);
      const child = join(root, "child");
      await mkdir(child);
      await chmod(root, 0o111);
      expect(await checkGitSafety(child, false)).toBe("git-unknown");
    } finally {
      process.env = originalEnv;
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);

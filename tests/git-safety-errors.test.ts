import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkGitSafety } from "../server/git-safety";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: execute,
  }),
}));

const notRepository =
  "fatal: not a git repository (or any of the parent directories): .git\n";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "workboard-git-errors-"));
  execute.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it.each([
  ["zh_CN.UTF-8", "zh_CN", "致命错误：不是 git 仓库"],
  ["de_DE.UTF-8", "de", "fatal: kein Git-Repository"],
  ["fr_FR.UTF-8", "fr", "fatal : ceci n'est pas un dépôt git"],
])(
  "recognizes a non-Git directory with host locale %s",
  async (locale, language, translated) => {
    vi.stubEnv("LC_ALL", locale);
    vi.stubEnv("LANG", locale);
    vi.stubEnv("LANGUAGE", language);
    // Model Git's translated diagnostics even when the installed Git has no catalogs.
    execute.mockImplementation(async (_file, _args, options) => {
      throw Object.assign(new Error("Git discovery failed"), {
        code: 128,
        stderr: options.env.LC_ALL === "C" ? notRepository : translated,
      });
    });
    expect(await checkGitSafety(directory, false)).toBeNull();
    expect(await checkGitSafety(directory, true)).toBe("git-unknown");
    expect(process.env.LC_ALL).toBe(locale);
    expect(process.env.LANG).toBe(locale);
    expect(process.env.LANGUAGE).toBe(language);
  },
);

it.each([
  ["missing executable", { code: "ENOENT" }],
  ["execution denied", { code: "EACCES" }],
  ["output limit", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
  ["timeout", { code: 128, killed: true }],
  ["signal", { code: 128, signal: "SIGTERM" }],
  ["unexpected exit", { code: 1 }],
])(
  "rejects %s even with a non-repository diagnostic",
  async (_name, failure) => {
    execute.mockRejectedValue(
      Object.assign(new Error("Git failed"), {
        stderr: notRepository,
        ...failure,
      }),
    );
    expect(await checkGitSafety(directory, false)).toBe("git-unknown");
  },
);

it.each([
  "fatal: cannot change to '/not a git repository': Permission denied\n",
  "fatal: cannot stat '/not a git repository': No such file or directory\n",
  "fatal: bad config line 1 in file /not a git repository\n",
  "fatal: not a git repository: /missing/gitdir\n",
  "致命错误：不是 git 仓库\n",
])("rejects an unrecognized discovery failure: %s", async (stderr) => {
  execute.mockRejectedValue(
    Object.assign(new Error("Git failed"), {
      code: 128,
      stderr,
    }),
  );
  expect(await checkGitSafety(directory, false)).toBe("git-unknown");
});

it("rejects a later command failure after successful repository discovery", async () => {
  execute.mockResolvedValueOnce({ stdout: directory, stderr: "" });
  execute.mockRejectedValueOnce(
    Object.assign(new Error("Git failed"), {
      code: 128,
      stderr: notRepository,
    }),
  );
  expect(await checkGitSafety(directory, false)).toBe("git-unknown");
});

it("accepts the filesystem-boundary discovery diagnostic for a non-Git directory", async () => {
  execute.mockRejectedValue(
    Object.assign(new Error("Git discovery failed"), {
      code: 128,
      stderr:
        "fatal: not a git repository (or any parent up to mount point /fixture)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n",
    }),
  );
  expect(await checkGitSafety(directory, false)).toBeNull();
});

it("rejects a directory removed during repository discovery", async () => {
  execute.mockImplementation(async () => {
    await rm(directory, { recursive: true });
    throw Object.assign(new Error("Git discovery failed"), {
      code: 128,
      stderr: notRepository,
    });
  });
  expect(await checkGitSafety(directory, false)).toBe("git-unknown");
});

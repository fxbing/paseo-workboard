// Checks, on a real Paseo host, that Workboard does not resume idle Agents.
//
//   node scripts/check-idle-wake.mjs seed     create idle fixture Agents in the marked home
//   (the runner restarts the daemon, so no Agent is loaded)
//   node scripts/check-idle-wake.mjs verify   wait through a periodic refresh and read the log
//
// It needs the isolated daemon that scripts/run-host-checks.mjs prepares and refuses any home
// that is not a marked temporary directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const MARKER = "paseo-workboard-integration-v1";
const PLUGIN = "paseo-workboard";
const FIXTURE = "workboard-fixture";
const TITLES = [
  ["Billing export fix", "task:in-progress"],
  ["Docs site refresh", "task:review"],
  ["Search tuning", "task:done"],
  ["Onboarding copy pass", "task:todo"],
];
const mode = process.argv[2];
if (mode !== "seed" && mode !== "verify")
  throw new Error("Usage: node scripts/check-idle-wake.mjs seed|verify");

const root = process.env.WORKBOARD_INTEGRATION_HOME;
assert(root, "Set WORKBOARD_INTEGRATION_HOME to an isolated Paseo home");
const home = await realpath(root);
const temporary = await Promise.all(
  [tmpdir(), "/tmp"].map((directory) => realpath(directory).catch(() => "")),
);
assert(
  temporary.some(
    (directory) => directory && home.startsWith(directory + path.sep),
  ),
  "The home must be inside a system temporary directory",
);
assert.equal(
  (
    await readFile(path.join(home, ".paseo-workboard-integration"), "utf8")
  ).trim(),
  MARKER,
);
const status = JSON.parse(
  spawnSync("paseo", ["status", "--home", home, "--json"], {
    encoding: "utf8",
  }).stdout,
);
assert.equal(await realpath(status.home), home);
assert(
  /^127\.0\.0\.1:\d+$/.test(status.listen),
  "The daemon must listen on loopback",
);

const client = new DaemonClient({
  url: `ws://${status.listen}/ws`,
  clientId: `workboard-idle-wake-${mode}`,
  clientType: "cli",
  appVersion: status.daemonVersion,
});
await client.connect();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rpc = (method) => client.invokePluginRpc(PLUGIN, method, {});

try {
  if (mode === "seed") {
    const plugins = await client.listPlugins();
    if (!plugins.some((plugin) => plugin.id === FIXTURE))
      await client.installDirectoryPlugin(
        path.resolve("tests/integration/fixture-provider"),
      );
    for (const [title, label] of TITLES) {
      const directory = path.join(
        home,
        "idle-wake",
        title.replace(/\W+/g, "-"),
      );
      await mkdir(directory, { recursive: true });
      const created = await client.createWorkspace({
        source: { kind: "directory", path: directory },
        title,
      });
      const workspaceId = created.workspace?.id;
      assert(workspaceId, `Paseo did not create ${title}`);
      const agent = await client.createAgent({
        provider: FIXTURE,
        model: "fixture-model",
        cwd: directory,
        workspaceId,
      });
      await client.refreshAgent(agent.id);
      await client.setWorkspaceLabel({
        workspaceId,
        label: { name: label, color: "emerald" },
        assigned: true,
      });
    }
    console.log(`Seeded ${TITLES.length} idle Agents.`);
  } else {
    // Wait for the restarted plugin to import every seeded workspace.
    let board;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        board = await rpc("workboard.snapshot");
        if (
          board.connected &&
          TITLES.every(([title]) => board.cards.some((c) => c.title === title))
        )
          break;
      } catch {
        // The plugin is still starting.
      }
      await sleep(1000);
    }
    assert(
      board?.connected &&
        TITLES.every(([title]) => board.cards.some((c) => c.title === title)),
      "Workboard did not import the seeded workspaces after the restart",
    );
    // One more periodic refresh (60 seconds) must also leave the Agents alone.
    await sleep(75_000);
    const lines = (await readFile(path.join(home, "daemon.log"), "utf8"))
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const restart = lines.findLastIndex((entry) =>
      /^Agent registry loaded \((\d+) records?\)/.test(entry.msg ?? ""),
    );
    assert(restart >= 0, "The daemon log has no agent registry line");
    const loaded = Number(
      /\((\d+) records?\)/.exec(lines[restart].msg)?.[1] ?? "0",
    );
    assert(loaded >= TITLES.length, `Only ${loaded} Agents were on disk`);
    const resumes = (from) =>
      lines
        .slice(from)
        .filter((entry) => entry.msg === "Agent resumed from persistence");
    const wokenByWorkboard = resumes(restart).filter(
      (entry) => entry.clientId === "plugin:paseo-workboard",
    );
    assert.equal(
      wokenByWorkboard.length,
      0,
      `Workboard resumed ${wokenByWorkboard.length} idle Agents`,
    );
    // Positive control: a client request does resume an Agent and is logged, so an empty
    // result above cannot just mean this host words the line differently.
    const agents = await client.fetchAgents({
      filter: { includeArchived: false },
      page: { limit: 50 },
    });
    const first = agents.entries[0]?.agent;
    assert(first, "No seeded Agent to resume as a control");
    await client.fetchAgentTimeline(first.id, { direction: "tail", limit: 5 });
    await sleep(1500);
    const after = (await readFile(path.join(home, "daemon.log"), "utf8"))
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    assert(
      after.some(
        (entry) =>
          entry.msg === "Agent resumed from persistence" &&
          entry.clientId === "workboard-idle-wake-verify",
      ),
      "The control request did not log a resume; this host's log wording is not recognized",
    );
    console.log(
      `Workboard resumed 0 of ${loaded} idle Agents across its start and a periodic refresh.`,
    );
  }
} finally {
  await client.close();
}

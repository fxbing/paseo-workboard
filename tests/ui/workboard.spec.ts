import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Board } from "../../shared/model";
import { isTemporaryIntegrationHome } from "../integration/temporary-home";

const run = promisify(execFile);
const pluginId = "paseo-workboard";
const fixtureId = "workboard-fixture";
let client: DaemonClient;
let home: string;

async function snapshot(): Promise<Board> {
  return (await client.invokePluginRpc(
    pluginId,
    "workboard.snapshot",
    {},
  )) as Board;
}

async function snapshotIfReady(): Promise<Board | null> {
  try {
    return await snapshot();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Workboard is starting")
    )
      return null;
    throw error;
  }
}

async function openWorkboard(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("Workboard", { exact: true }).first().click();
  await expect(page.getByTestId("workboard-view-board")).toBeVisible();
}

async function seedOldDoneTask(): Promise<string> {
  const initial = await snapshot();
  if (
    initial.settings.archiveDoneEnabled ||
    initial.settings.archiveCanceledEnabled
  )
    await client.invokePluginRpc(pluginId, "workboard.mutate", {
      action: "settings",
      revision: initial.revision,
      expectedSettings: initial.settings,
      settings: {
        ...initial.settings,
        archiveDoneEnabled: false,
        archiveCanceledEnabled: false,
      },
    });
  const title = `UI archive candidate ${Date.now()}`;
  const directory = path.join(home, "ui-archive-candidate", String(Date.now()));
  await mkdir(directory, { recursive: true });
  const created = await client.createWorkspace({
    source: { kind: "directory", path: directory },
    title,
  });
  const workspaceId = created.workspace?.id;
  if (!workspaceId)
    throw new Error("Paseo did not create the UI fixture workspace");
  const agent = await client.createAgent({
    provider: fixtureId,
    model: "fixture-model",
    cwd: directory,
    workspaceId,
  });
  await client.refreshAgent(agent.id);
  await client.setWorkspaceLabel({
    workspaceId,
    label: { name: "task:done", color: "emerald" },
    assigned: true,
  });
  await client.reloadPlugin(pluginId);
  await expect
    .poll(
      async () => {
        const card = (await snapshotIfReady())?.cards.find(
          (item) => item.workspaceId === workspaceId,
        );
        return (
          card?.stage === "done" &&
          card.conversationGateAt !== null &&
          Date.parse(card.conversationGateAt) <
            Date.now() - 31 * 24 * 60 * 60 * 1000
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return title;
}

test.beforeAll(async () => {
  const requestedHome = process.env.WORKBOARD_INTEGRATION_HOME;
  const requestedUrl = process.env.WORKBOARD_BASE_URL;
  if (!requestedHome || !requestedUrl)
    throw new Error("Run UI tests through the isolated host runner");
  home = await realpath(requestedHome);
  if (!(await isTemporaryIntegrationHome(home)))
    throw new Error("UI tests require a system temporary integration home");
  if (
    (
      await readFile(path.join(home, ".paseo-workboard-integration"), "utf8")
    ).trim() !== "paseo-workboard-integration-v1"
  )
    throw new Error("UI tests require the integration home marker");
  const { stdout } = await run("paseo", ["status", "--home", home, "--json"], {
    encoding: "utf8",
  });
  const status = JSON.parse(stdout) as {
    home: string;
    listen: string;
    daemonVersion: string;
  };
  if (
    (await realpath(status.home)) !== home ||
    !/^127\.0\.0\.1:\d+$/.test(status.listen) ||
    requestedUrl !== `http://${status.listen}`
  )
    throw new Error("UI URL does not match the isolated loopback daemon");
  client = new DaemonClient({
    url: `ws://${status.listen}/ws`,
    clientId: `workboard-ui-${Date.now()}`,
    clientType: "cli",
    appVersion: status.daemonVersion,
  });
  await client.connect();
  const plugins = await client.listPlugins();
  for (const id of [pluginId, fixtureId])
    if (
      !plugins.some((plugin) => plugin.id === id && plugin.status === "running")
    )
      throw new Error(`Required isolated plugin is not running: ${id}`);
  await expect
    .poll(async () => (await snapshotIfReady())?.connected, {
      timeout: 20_000,
    })
    .toBe(true);
});

test.afterAll(async () => {
  await client?.close();
});

test("creates a draft through the page and displays it in Board and List", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openWorkboard(page);
  const title = `UI draft ${Date.now()}`;
  await page
    .getByRole("button", { name: /^(New task|新建任务)$/ })
    .first()
    .click();
  await page.getByRole("textbox", { name: /^(Title|标题)$/ }).fill(title);
  await page.getByRole("button", { name: /^(Create draft|创建草稿)$/ }).click();
  let cardId = "";
  await expect
    .poll(async () => {
      cardId =
        (await snapshot()).cards.find((card) => card.title === title)?.id ?? "";
      return cardId;
    })
    .not.toBe("");
  await expect(page.getByTestId(`workboard-card-${cardId}`)).toContainText(
    title,
  );
  await page.getByTestId("workboard-view-list").click();
  await expect(page.getByTestId("workboard-view-list")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId(`workboard-list-task-${cardId}`)).toContainText(
    title,
  );
  expect(pageErrors).toEqual([]);
});

test("keeps archive delays visible while disabled and Cancel leaves the rule off", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const title = await seedOldDoneTask();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openWorkboard(page);
  await page
    .getByRole("button", { name: /^(Settings|设置)$/ })
    .last()
    .click();
  await expect(
    page.getByTestId("workboard-archive-done-delay-row"),
  ).toBeVisible();
  await expect(
    page.getByTestId("workboard-archive-canceled-delay-row"),
  ).toBeVisible();
  await expect(page.getByTestId("workboard-archive-done-days")).toBeVisible();
  await expect(
    page.getByTestId("workboard-archive-canceled-days"),
  ).toBeVisible();
  await page
    .getByRole("switch", {
      name: /^(Automatically archive Done tasks|自动归档已完成任务)$/,
    })
    .click();
  await expect(
    page.getByText(/Save automatic archive settings|保存自动归档设置/, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("workboard-archive-candidates")).toContainText(
    title,
  );
  await page.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
  await expect(
    page.getByText(/Save automatic archive settings|保存自动归档设置/, {
      exact: true,
    }),
  ).toBeHidden();
  const afterCancel = await snapshot();
  expect(afterCancel.settings.archiveDoneEnabled).toBe(false);
  expect(
    afterCancel.cards.find((card) => card.title === title)?.archived,
  ).toBeNull();
  expect(pageErrors).toEqual([]);
});

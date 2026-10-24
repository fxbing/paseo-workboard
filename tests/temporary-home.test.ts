import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { isTemporaryIntegrationHome } from "./integration/temporary-home";

test("accepts a system temporary home when the /tmp alias is absent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "workboard-temp-home-"));
  try {
    const missingAlias = path.join(home, "missing-tmp-alias");
    expect(
      await isTemporaryIntegrationHome(await realpath(home), missingAlias),
    ).toBe(true);
    const temporaryRoot = await realpath(tmpdir());
    expect(await isTemporaryIntegrationHome(temporaryRoot, missingAlias)).toBe(
      false,
    );
    expect(
      await isTemporaryIntegrationHome(
        `${temporaryRoot}-sibling${path.sep}fixture`,
        missingAlias,
      ),
    ).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("does not ignore errors other than a missing /tmp alias", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "workboard-temp-home-"));
  try {
    await expect(
      isTemporaryIntegrationHome(await realpath(home), "invalid\0tmp"),
    ).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

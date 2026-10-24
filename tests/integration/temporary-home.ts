import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function isTemporaryIntegrationHome(
  home: string,
  legacyTmp = "/tmp",
): Promise<boolean> {
  const roots = [await realpath(tmpdir())];
  try {
    roots.push(await realpath(legacyTmp));
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  return roots.some((directory) => home.startsWith(`${directory}${path.sep}`));
}

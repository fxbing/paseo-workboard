import { describe, expect, it } from "vitest";
import {
  loadCollapsedColumns,
  loadCollapsedColumnsFrom,
  saveCollapsedColumns,
  saveCollapsedColumnsTo,
} from "../client/column-preferences";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("collapsed column preferences", () => {
  it("keeps the board usable when browser storage access itself is denied", () => {
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Storage access denied");
      },
    });
    try {
      expect(loadCollapsedColumns("host-a")).toEqual([]);
      expect(saveCollapsedColumns("host-a", ["done"])).toBe(false);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
  it("does not require browser storage outside the web host", () => {
    expect(loadCollapsedColumns("host-a")).toEqual([]);
  });

  it("persists a host's unique column ids without accepting malformed saved data", () => {
    const clientStorage = storage();

    expect(
      saveCollapsedColumnsTo(clientStorage, "host-a", ["todo", "todo", ""]),
    ).toBe(true);
    expect(loadCollapsedColumnsFrom(clientStorage, "host-a")).toEqual(["todo"]);
    expect(loadCollapsedColumnsFrom(clientStorage, "host-b")).toEqual([]);

    clientStorage.setItem("paseo-workboard:collapsed-columns:host-a", "{bad");
    expect(loadCollapsedColumnsFrom(clientStorage, "host-a")).toEqual([]);
  });
});

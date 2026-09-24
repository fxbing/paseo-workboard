import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readPaseoLanguage,
  subscribePaseoLanguage,
} from "../client/paseo-language";
import { shortDate } from "../client/board-utils";
import { strings } from "../client/strings";

const values = new Map<string, string>();
const events = new Map<string, Set<() => void>>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: vi.fn(),
};
const choose = (language: string) =>
  values.set(
    "@paseo:app-settings",
    JSON.stringify({ language, theme: "auto" }),
  );

beforeEach(() => {
  values.clear();
  events.clear();
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: (name: string, listener: () => void) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(listener);
    },
    removeEventListener: (name: string, listener: () => void) =>
      events.get(name)?.delete(listener),
  });
  vi.stubGlobal("navigator", { languages: ["zh-CN", "en-US"] });
});

afterEach(() => {
  expect(storage.setItem).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("follows explicit Paseo choices even when the system language disagrees", () => {
  choose("en");
  expect(readPaseoLanguage()).toBe("en");
  vi.stubGlobal("navigator", { languages: ["en-US"] });
  choose("zh-CN");
  expect(readPaseoLanguage()).toBe("zh");
  choose("ja");
  expect(readPaseoLanguage()).toBe("en");
});

it.each([
  [["zh-Hans-CN", "en-US"], "zh"],
  [["en-GB", "zh-CN"], "en"],
  [["fr-FR", "zh-CN"], "en"],
  [["unknown", "zh-CN"], "zh"],
  [["zh-TW", "en-US"], "en"],
] as const)(
  "matches Paseo's system-language priority for %j",
  (locales, expected) => {
    choose("system");
    vi.stubGlobal("navigator", { languages: locales });
    expect(readPaseoLanguage()).toBe(expected);
  },
);

it("uses the legacy key only when the current Paseo settings are absent", () => {
  values.set("@paseo:settings", JSON.stringify({ language: "zh-CN" }));
  expect(readPaseoLanguage()).toBe("zh");
  choose("en");
  expect(readPaseoLanguage()).toBe("en");
});

it("switches built-in labels and dates together", () => {
  const date = "2026-09-23T12:00:00Z";
  choose("zh-CN");
  const chinese = strings(readPaseoLanguage());
  expect(chinese.settingsTitle).toBe("设置");
  expect(shortDate(date, chinese.locale)).toBe("9月23日");
  choose("en");
  const english = strings(readPaseoLanguage());
  expect(english.settingsTitle).toBe("Settings");
  expect(shortDate(date, english.locale)).toBe("Sep 23");
});

it("observes same-window changes without a storage event and releases its listeners", () => {
  choose("en");
  const seen: string[] = [];
  const stop = subscribePaseoLanguage(() => seen.push(readPaseoLanguage()));
  choose("zh-CN");
  vi.advanceTimersByTime(1_000);
  expect(seen).toEqual(["zh"]);
  choose("en");
  for (const listener of events.get("storage") ?? []) listener();
  expect(seen).toEqual(["zh", "en"]);
  stop();
  choose("zh-CN");
  vi.advanceTimersByTime(2_000);
  for (const listeners of events.values()) expect(listeners.size).toBe(0);
  expect(seen).toEqual(["zh", "en"]);
});

it("keeps rendering when client storage is corrupt, denied or unavailable", () => {
  values.set("@paseo:app-settings", "{broken");
  expect(readPaseoLanguage()).toBe("en");
  vi.stubGlobal("window", {
    get localStorage() {
      throw new Error("Storage denied");
    },
  });
  expect(readPaseoLanguage()).toBe("en");
  vi.stubGlobal("window", undefined);
  expect(readPaseoLanguage()).toBe("en");
  expect(() => subscribePaseoLanguage(() => {})()).not.toThrow();
});

import { expect, it, vi } from "vitest";
import { usePaseoLanguage } from "../client/paseo-language";
import { shortDate } from "../client/board-utils";
import { strings } from "../client/strings";

const host = vi.hoisted(() => ({ locale: "en" }));
vi.mock("@getpaseo/plugin/client", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ locale: host.locale }),
}));

it("uses the host locale for labels and dates as it changes", () => {
  const date = "2026-09-23T12:00:00Z";
  host.locale = "zh-CN";
  const chinese = strings(usePaseoLanguage());
  expect(chinese.settingsTitle).toBe("设置");
  expect(shortDate(date, chinese.locale)).toBe("9月23日");
  for (const locale of ["en", "fr", "zh-TW"]) {
    host.locale = locale;
    const english = strings(usePaseoLanguage());
    expect(english.settingsTitle).toBe("Settings");
    expect(shortDate(date, english.locale)).toBe("Sep 23");
  }
});

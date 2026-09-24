import type { Language } from "./strings";
import { useSyncExternalStore } from "react";

declare const window: {
  localStorage: { getItem(key: string): string | null };
  addEventListener(name: string, listener: () => void): void;
  removeEventListener(name: string, listener: () => void): void;
};
declare const navigator: { languages: readonly string[] };

// Paseo 0.9.1 exposes no client locale API. Read its Web/Electron settings,
// never write them. Revalidate these keys and system matching when upgrading.
const otherLocales = ["ar", "en", "es", "fr", "ja", "ko", "ru"];

export function readPaseoLanguage(): Language {
  if (typeof window === "undefined") return "en";
  try {
    const stored =
      window.localStorage.getItem("@paseo:app-settings") ??
      window.localStorage.getItem("@paseo:settings");
    const selected = JSON.parse(stored ?? "{}")?.language;
    if (selected === "zh-CN") return "zh";
    if (otherLocales.includes(selected) || selected === "pt-BR") return "en";
    // Paseo defaults missing/invalid settings to system, then picks its first
    // supported locale. Do not skip French, for example, to find later Chinese.
    for (const locale of navigator.languages) {
      const normalized = locale.toLowerCase();
      if (
        otherLocales.includes(normalized.split("-", 1)[0]) ||
        normalized === "pt" ||
        normalized === "pt-br"
      )
        return "en";
      if (
        normalized === "zh" ||
        normalized === "zh-cn" ||
        normalized.startsWith("zh-hans")
      )
        return "zh";
    }
  } catch {
    // Unavailable storage must not make the board unusable.
  }
  return "en";
}

export function subscribePaseoLanguage(changed: () => void): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  )
    return () => {};
  window.addEventListener("storage", changed);
  window.addEventListener("focus", changed);
  // Storage events do not fire in the window that changes Paseo's settings.
  const timer = setInterval(changed, 1_000);
  return () => {
    clearInterval(timer);
    window.removeEventListener("storage", changed);
    window.removeEventListener("focus", changed);
  };
}

export function usePaseoLanguage(): Language {
  return useSyncExternalStore(
    subscribePaseoLanguage,
    readPaseoLanguage,
    () => "en",
  );
}

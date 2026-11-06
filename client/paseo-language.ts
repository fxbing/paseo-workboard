import { defineTranslations, useTranslation } from "@getpaseo/plugin/client";
import type { Language } from "./strings";

export const messages = defineTranslations({
  resources: { en: { title: "Workboard" } },
});

export function usePaseoLanguage(): Language {
  const { locale } = useTranslation(messages);
  return locale === "zh-CN" ? "zh" : "en";
}

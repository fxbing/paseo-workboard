import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { groupColorKey, type Group, type GroupColor } from "../shared/model";

type Theme = PluginSurfaceProps["theme"];

export const groupColor = (group: Group, theme: Theme): string =>
  groupColorValue(groupColorKey(group), theme);

export function groupColorValue(color: GroupColor, theme: Theme): string {
  switch (color) {
    case "gray":
      return theme.colors.foregroundMuted;
    case "green":
      return theme.colors.statusSuccess;
    case "amber":
      return theme.colors.statusWarning;
    case "red":
      return theme.colors.statusDanger;
    case "blue":
      return supplementalColor(theme, "#2563eb", "#60a5fa");
    case "cyan":
      return supplementalColor(theme, "#0e7490", "#22d3ee");
    case "teal":
      return supplementalColor(theme, "#0f766e", "#2dd4bf");
    case "orange":
      return supplementalColor(theme, "#c2410c", "#fb923c");
    case "violet":
      return supplementalColor(theme, "#7c3aed", "#a78bfa");
    case "pink":
      return supplementalColor(theme, "#be185d", "#f472b6");
  }
}

// Paseo 0.9.1 exposes semantic tokens but no light/dark mode flag.
export function supplementalColor(
  theme: Theme,
  light: string,
  dark: string,
): string {
  const hex = /^#([a-f\d]{6})$/i.exec(theme.colors.surface0)?.[1];
  if (!hex) return theme.colors.accent;
  const brightness = [0, 2, 4].reduce(
    (sum, offset, i) =>
      sum +
      parseInt(hex.slice(offset, offset + 2), 16) * [0.2126, 0.7152, 0.0722][i],
    0,
  );
  return brightness < 128 ? dark : light;
}

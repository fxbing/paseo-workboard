import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { groupColorKey, type Group, type GroupColor } from "../shared/model";

type Theme = PluginSurfaceProps["theme"];
const PALETTE: Record<GroupColor, readonly [string, string]> = {
  gray: ["#64748b", "#94a3b8"],
  blue: ["#2563eb", "#60a5fa"],
  cyan: ["#0e7490", "#22d3ee"],
  teal: ["#0f766e", "#2dd4bf"],
  green: ["#15803d", "#4ade80"],
  amber: ["#b45309", "#fbbf24"],
  orange: ["#c2410c", "#fb923c"],
  violet: ["#7c3aed", "#a78bfa"],
  pink: ["#be185d", "#f472b6"],
  red: ["#dc2626", "#f87171"],
};
export const groupColor = (group: Group, theme: Theme): string =>
  groupColorValue(groupColorKey(group), theme);

export function groupColorValue(color: GroupColor, theme: Theme): string {
  return supplementalColor(theme, ...PALETTE[color]);
}

// The theme exposes strings, without a mode flag. Alpha does not identify a backing surface.
function surfaceRgb(value: string): number[] | null {
  const hex = /^#([a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(value.trim())?.[1];
  if (hex) {
    const expanded =
      hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((offset) =>
      parseInt(expanded.slice(offset, offset + 2), 16),
    );
  }
  const rgb = /^(rgb|rgba)\(([^)]+)\)$/i.exec(value.trim());
  if (!rgb) return null;
  const parts = rgb[2].split(",").map((part) => part.trim());
  if (parts.length !== (rgb[1].toLowerCase() === "rgba" ? 4 : 3)) return null;
  const channels = parts.slice(0, 3).map((part) => {
    if (!/^\d+(?:\.\d+)?%?$/.test(part)) return NaN;
    const percent = part.endsWith("%");
    const number = parseFloat(part);
    return number <= (percent ? 100 : 255)
      ? number * (percent ? 2.55 : 1)
      : NaN;
  });
  if (channels.some((channel) => !Number.isFinite(channel))) return null;
  if (
    parts.length === 4 &&
    (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(parts[3]) || Number(parts[3]) > 1)
  )
    return null;
  return channels;
}
export function supplementalColor(
  theme: Theme,
  light: string,
  dark: string,
): string {
  const rgb = surfaceRgb(theme.colors.surface0);
  if (!rgb) return light;
  const brightness = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return brightness < 128 ? dark : light;
}

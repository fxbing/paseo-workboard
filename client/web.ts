import { Platform, type ViewStyle } from "react-native";
import { columnWidth } from "./board-utils";
import { DEFAULT_FILTERS, parseFilters, type BoardFilters } from "./filters";

type KeyEvent = {
  key: string;
  altKey?: boolean;
  metaKey?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};
declare const window: {
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  addEventListener(name: string, callback: () => void): void;
  removeEventListener(name: string, callback: () => void): void;
};
declare const document: {
  body: { style: { userSelect: string; cursor: string } };
  addEventListener(
    name: string,
    callback: (event: KeyEvent) => void,
    capture?: boolean,
  ): void;
  removeEventListener(
    name: string,
    callback: (event: KeyEvent) => void,
    capture?: boolean,
  ): void;
};

const storageKey = (host: string) => `paseo-workboard:column-widths:${host}`;

export function loadBoardFilters(host: string): BoardFilters {
  if (Platform.OS !== "web") return DEFAULT_FILTERS;
  try {
    return parseFilters(
      window.localStorage.getItem(`paseo-workboard:filters:${host}`),
    );
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveBoardFilters(host: string, filters: BoardFilters): boolean {
  if (Platform.OS !== "web") return true;
  try {
    window.localStorage.setItem(
      `paseo-workboard:filters:${host}`,
      JSON.stringify(filters),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadColumnWidths(host: string): Record<string, number> {
  if (Platform.OS !== "web") return {};
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(host)) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([, width]) => typeof width === "number" && Number.isFinite(width),
        )
        .map(([id, width]) => [id, columnWidth(width as number)]),
    );
  } catch {
    return {};
  }
}

export function saveColumnWidths(
  host: string,
  widths: Record<string, number>,
): boolean {
  if (Platform.OS !== "web") return true;
  try {
    window.localStorage.setItem(storageKey(host), JSON.stringify(widths));
    return true;
  } catch {
    return false;
  }
}

export function dragCursor(resize = false): ViewStyle {
  return Platform.OS === "web"
    ? ({
        cursor: resize ? "col-resize" : "grab",
        touchAction: "none",
      } as unknown as ViewStyle)
    : {};
}

export function keyboardProps(
  onKey: (key: string, event: KeyEvent) => boolean,
) {
  if (Platform.OS !== "web") return {};
  return {
    onKeyDown(event: KeyEvent) {
      if (onKey(event.key, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}

export function toggleButtonState(selected: boolean) {
  return Platform.OS === "web"
    ? { "aria-pressed": selected }
    : { accessibilityState: { selected } };
}

export function duringDrag(cancel: () => void, resize = false): () => void {
  if (Platform.OS !== "web") return () => {};
  const { cursor, userSelect } = document.body.style;
  document.body.style.cursor = resize ? "col-resize" : "grabbing";
  document.body.style.userSelect = "none";
  const onKey = (event: KeyEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", cancel);
  return () => {
    document.body.style.cursor = cursor;
    document.body.style.userSelect = userSelect;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", cancel);
  };
}

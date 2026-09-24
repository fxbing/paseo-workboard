type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

declare const localStorage: StorageLike | undefined;

const storageKey = (host: string) =>
  `paseo-workboard:collapsed-columns:${host}`;

function collapsedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ];
}

export function loadCollapsedColumnsFrom(
  storage: StorageLike,
  host: string,
): string[] {
  try {
    return collapsedIds(JSON.parse(storage.getItem(storageKey(host)) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveCollapsedColumnsTo(
  storage: StorageLike,
  host: string,
  ids: readonly string[],
): boolean {
  try {
    storage.setItem(storageKey(host), JSON.stringify(collapsedIds(ids)));
    return true;
  } catch {
    return false;
  }
}

export function loadCollapsedColumns(host: string): string[] {
  try {
    return typeof localStorage === "undefined"
      ? []
      : loadCollapsedColumnsFrom(localStorage, host);
  } catch {
    return [];
  }
}

export function saveCollapsedColumns(
  host: string,
  ids: readonly string[],
): boolean {
  try {
    return (
      typeof localStorage === "undefined" ||
      saveCollapsedColumnsTo(localStorage, host, ids)
    );
  } catch {
    return false;
  }
}

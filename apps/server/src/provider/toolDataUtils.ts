export function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

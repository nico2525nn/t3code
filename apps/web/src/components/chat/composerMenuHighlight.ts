export function resolveComposerMenuActiveItemId(input: {
  items: ReadonlyArray<{ id: string }>;
  highlightedItemId: string | null;
  currentSearchKey: string | null;
  highlightedSearchKey: string | null;
}): string | null {
  if (input.items.length === 0) {
    return null;
  }

  if (
    input.currentSearchKey === input.highlightedSearchKey &&
    input.highlightedItemId &&
    input.items.some((item) => item.id === input.highlightedItemId)
  ) {
    return input.highlightedItemId;
  }

  return input.items[0]?.id ?? null;
}

export function resolveComposerMenuNudgedItemId(input: {
  items: ReadonlyArray<{ id: string }>;
  activeItemId: string | null;
  direction: "next" | "previous";
}): string | null {
  if (input.items.length === 0) {
    return null;
  }

  const activeIndex = input.items.findIndex((item) => item.id === input.activeItemId);
  const normalizedIndex =
    activeIndex >= 0 ? activeIndex : input.direction === "next" ? -1 : 0;
  const offset = input.direction === "next" ? 1 : -1;
  const nextIndex = (normalizedIndex + offset + input.items.length) % input.items.length;

  return input.items[nextIndex]?.id ?? null;
}

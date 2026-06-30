export type NativeTopScrollEdgeEffect = "automatic" | "soft";
export type NativeHeaderScrollEdgeEffects = {
  readonly top: NativeTopScrollEdgeEffect;
  readonly bottom: "hidden";
  readonly left: "hidden";
  readonly right: "hidden";
};

function majorVersion(version: number | string): number {
  if (typeof version === "number") {
    return Math.trunc(version);
  }

  const parsed = Number.parseInt(version, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * iOS 27's system apps use a soft scroll-edge treatment for Messages-style
 * chrome. Avoid the `hard` style here: it adds the dividing line that makes the
 * header feel custom and heavier than Messages/Mail.
 */
export function nativeTopScrollEdgeEffect(
  os: string,
  version: number | string,
): NativeTopScrollEdgeEffect {
  return os === "ios" && majorVersion(version) >= 27 ? "soft" : "automatic";
}

export function nativeHeaderScrollEdgeEffects(
  os: string,
  version: number | string,
): NativeHeaderScrollEdgeEffects {
  return {
    top: nativeTopScrollEdgeEffect(os, version),
    bottom: "hidden",
    left: "hidden",
    right: "hidden",
  };
}

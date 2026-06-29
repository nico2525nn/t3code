export type NativeTopScrollEdgeEffect = "automatic" | "soft";

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

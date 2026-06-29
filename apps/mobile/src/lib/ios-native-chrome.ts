export type NativeChromeColorScheme = "dark" | "light" | "unspecified" | null | undefined;

/**
 * Tint used for iOS 27 glass header buttons. UIKit still owns the actual
 * material; this color only nudges the sampled glass toward Mail/Messages'
 * button tone without baking custom blur into React views.
 */
export function iosNativeGlassButtonTint(colorScheme: NativeChromeColorScheme): string {
  return colorScheme === "dark" ? "rgba(62,62,66,0.88)" : "rgba(255,255,255,0.82)";
}

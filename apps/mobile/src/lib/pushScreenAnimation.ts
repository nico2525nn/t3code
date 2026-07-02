import { Platform } from "react-native";

/**
 * Stack animation for pushed (non-sheet) screens.
 *
 * iOS keeps the default push animation: forcing `slide_from_right` switches
 * react-native-screens to its custom swipe animator, which paints a black
 * void behind the outgoing screen during interactive swipe-back. The native
 * default is visually the same slide with proper parallax over the previous
 * screen. Android has no interactive pop, so it keeps `slide_from_right`.
 */
export const pushScreenAnimation = Platform.OS === "ios" ? "default" : "slide_from_right";

import Stack from "expo-router/stack";
import { StyleSheet } from "react-native";
import { useResolveClassNames } from "uniwind";

import { pushScreenAnimation } from "../../../../lib/pushScreenAnimation";
import { useHeaderBlurEffect } from "../../../../lib/useHeaderBlurEffect";

export default function ThreadLayout() {
  const headerBlurEffect = useHeaderBlurEffect();
  const sheetStyle = StyleSheet.flatten(useResolveClassNames("bg-sheet"));
  const headerBg = {
    backgroundColor: (sheetStyle as { backgroundColor?: string })?.backgroundColor,
  };

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="index"
        options={{
          contentStyle: { backgroundColor: "transparent" },
          headerShown: true,
          headerTransparent: true,
          headerBlurEffect,
          headerShadowVisible: false,
          headerTitle: "",
        }}
      />
      <Stack.Screen
        name="git"
        options={{
          contentStyle: sheetStyle,
          gestureEnabled: true,
          headerShown: false,
          presentation: "formSheet" as const,
          sheetAllowedDetents: [0.85],
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="git-confirm"
        options={{
          contentStyle: sheetStyle,
          gestureEnabled: true,
          headerShown: false,
          presentation: "formSheet" as const,
          sheetAllowedDetents: [0.4],
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="review"
        options={{
          animation: pushScreenAnimation,
          contentStyle: sheetStyle,
          fullScreenGestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerTitle: "Files changed",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
      <Stack.Screen
        name="files/index"
        options={{
          animation: pushScreenAnimation,
          contentStyle: sheetStyle,
          fullScreenGestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerTitle: "Files",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
      <Stack.Screen
        name="files/[...path]"
        options={{
          animation: pushScreenAnimation,
          contentStyle: sheetStyle,
          fullScreenGestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerTitle: "File",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
      <Stack.Screen
        name="review-comment"
        options={{
          contentStyle: sheetStyle,
          gestureEnabled: true,
          headerShown: false,
          presentation: "formSheet" as const,
          sheetAllowedDetents: [0.72, 0.92],
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="terminal"
        options={{
          animation: pushScreenAnimation,
          contentStyle: { backgroundColor: "#050505" },
          // No fullScreenGestureEnabled here: the terminal consumes
          // horizontal pans (readline editing, mouse reporting), so
          // back-swipe stays confined to the screen edge.
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerShadowVisible: false,
        }}
      />
    </Stack>
  );
}

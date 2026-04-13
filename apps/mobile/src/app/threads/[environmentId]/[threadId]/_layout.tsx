import Stack from "expo-router/stack";
import { StyleSheet } from "react-native";
import { useResolveClassNames } from "uniwind";

export default function ThreadLayout() {
  const sheetStyle = StyleSheet.flatten(useResolveClassNames("bg-sheet"));

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="index"
        options={{
          contentStyle: { backgroundColor: "transparent" },
          headerShown: true,
          headerTransparent: true,
          headerShadowVisible: false,
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
    </Stack>
  );
}

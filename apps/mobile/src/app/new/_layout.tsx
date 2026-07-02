import Stack from "expo-router/stack";
import { useResolveClassNames } from "uniwind";

import { NewTaskFlowProvider } from "../../features/threads/new-task-flow-provider";
import { pushScreenAnimation } from "../../lib/pushScreenAnimation";
import { useThemeColor } from "../../lib/useThemeColor";

export const unstable_settings = {
  anchor: "index",
};

export default function NewTaskLayout() {
  const sheetStyle = useResolveClassNames("bg-sheet");
  const sheetBg = useThemeColor("--color-sheet");
  const headerTint = useThemeColor("--color-foreground");

  return (
    <NewTaskFlowProvider>
      <Stack
        screenOptions={{
          contentStyle: sheetStyle,
          headerBackButtonDisplayMode: "minimal",
          headerLargeTitle: false,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: sheetBg },
          headerTintColor: headerTint,
          headerTitleStyle: { fontFamily: "DMSans_700Bold" },
        }}
      >
        <Stack.Screen name="index" options={{ animation: "none", title: "Choose project" }} />
        <Stack.Screen
          name="add-project/index"
          options={{ animation: pushScreenAnimation, title: "New project" }}
        />
        <Stack.Screen
          name="add-project/repository"
          options={{ animation: pushScreenAnimation, title: "Repository" }}
        />
        <Stack.Screen
          name="add-project/destination"
          options={{ animation: pushScreenAnimation, title: "Clone destination" }}
        />
        <Stack.Screen
          name="add-project/local"
          options={{ animation: pushScreenAnimation, title: "Local folder" }}
        />
        <Stack.Screen name="draft" options={{ animation: pushScreenAnimation, title: "New task" }} />
      </Stack>
    </NewTaskFlowProvider>
  );
}

import Stack from "expo-router/stack";
import { useColorScheme } from "react-native";

import { makeAppPalette } from "../../lib/theme";
import { NewTaskFlowProvider } from "../../features/threads/new-task-flow-provider";

export const unstable_settings = {
  anchor: "index",
};

export default function NewTaskLayout() {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);

  return (
    <NewTaskFlowProvider>
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: palette.sheetBackground },
          headerShown: false,
        }}
      >
        <Stack.Screen name="index" options={{ animation: "none" }} />
        <Stack.Screen name="draft" options={{ animation: "slide_from_right" }} />
      </Stack>
    </NewTaskFlowProvider>
  );
}

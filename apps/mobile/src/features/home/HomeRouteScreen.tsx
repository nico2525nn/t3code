import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { Platform, Pressable, useColorScheme } from "react-native";

import { makeAppPalette } from "../../lib/theme";
import { ConnectionStatusDot } from "../../features/connection/ConnectionStatusDot";
import { useRemoteApp } from "../../state/remote-app-state-provider";
import { buildThreadRoutePath } from "../../lib/routes";
import { HomeScreen } from "./HomeScreen";

export function HomeRouteScreen() {
  const app = useRemoteApp();
  const router = useRouter();
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const useNativeToolbar = Platform.OS === "ios";

  useFocusEffect(
    useCallback(() => {
      app.onBackFromThread();
    }, [app]),
  );

  return (
    <>
      {useNativeToolbar ? (
        <>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.View>
              <Pressable
                accessibilityLabel="Open backends"
                accessibilityRole="button"
                className="h-11 w-11 items-center justify-center rounded-full"
                onPress={() => router.push("/connections")}
                style={{ backgroundColor: palette.subtleBg }}
              >
                <ConnectionStatusDot state={app.connectionState} pulse={app.hasRemoteActivity} />
              </Pressable>
            </Stack.Toolbar.View>
          </Stack.Toolbar>
          <Stack.Toolbar>
            <Stack.Toolbar.Spacer />
            <Stack.Toolbar.Button icon="square.and.pencil" onPress={() => router.push("/new")}>
              New task
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      ) : null}

      <HomeScreen
        projects={app.projects}
        threads={app.threads}
        connectionState={app.connectionState}
        connectionPulse={app.hasRemoteActivity}
        onOpenConnectionEditor={() => router.push("/connections")}
        onOpenNewTask={() => router.push("/new")}
        onSelectThread={(thread) => {
          app.onSelectThread(thread);
          router.push(buildThreadRoutePath(thread));
        }}
        showFloatingConnectionButton={!useNativeToolbar}
        showFloatingNewTaskButton={!useNativeToolbar}
      />
    </>
  );
}

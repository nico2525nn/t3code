import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";

import { buildThreadRoutePath } from "../../lib/routes";
import { useRemoteApp } from "../../state/remote-app-state-provider";
import { HomeScreen } from "./HomeScreen";

export function HomeRouteScreen() {
  const app = useRemoteApp();
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      app.onBackFromThread();
    }, [app]),
  );

  return (
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
      showFloatingConnectionButton
      showFloatingNewTaskButton
    />
  );
}

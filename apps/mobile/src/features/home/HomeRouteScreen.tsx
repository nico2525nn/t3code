import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";

import { buildThreadRoutePath } from "../../lib/routes";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import { useThreadSelection } from "../../state/use-thread-selection";
import { HomeScreen } from "./HomeScreen";

export function HomeRouteScreen() {
  const { connectionState, hasRemoteActivity, projects, threads } = useRemoteCatalog();
  const { onBackFromThread, onSelectThread } = useThreadSelection();
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      onBackFromThread();
    }, [onBackFromThread]),
  );

  return (
    <HomeScreen
      projects={projects}
      threads={threads}
      connectionState={connectionState}
      connectionPulse={hasRemoteActivity}
      onOpenConnectionEditor={() => router.push("/connections")}
      onOpenNewTask={() => router.push("/new")}
      onSelectThread={(thread) => {
        onSelectThread(thread);
        router.push(buildThreadRoutePath(thread));
      }}
      showFloatingConnectionButton
      showFloatingNewTaskButton
    />
  );
}

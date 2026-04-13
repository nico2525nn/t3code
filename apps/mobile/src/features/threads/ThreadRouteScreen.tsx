import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text as RNText, View, useColorScheme } from "react-native";
import { useThemeColor } from "../../lib/useThemeColor";
import { useGitStatus, gitStatusManager } from "../../state/use-git-status";

import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadRoutePath } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { connectionTone } from "../connection/connectionTone";
import { firstNonNull } from "../../state/remote-runtime-types";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadCommands } from "../../state/use-selected-thread-commands";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { useThreadDetailSubscription } from "../../state/use-thread-detail-subscription";
import { useThreadSelection } from "../../state/use-thread-selection";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import { ThreadGitControls } from "./ThreadGitControls";
import { ThreadNavigationDrawer } from "./ThreadNavigationDrawer";
import { screenTitle } from "./threadPresentation";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

export function ThreadRouteScreen() {
  const { isLoadingSavedConnection, environmentStateById } = useRemoteEnvironmentState();
  const { connectionState, connectionError } = useRemoteConnectionStatus();
  const { projects, threads } = useRemoteCatalog();
  const {
    onSelectThread,
    selectedThread,
    selectedThreadProject,
    selectedEnvironmentConnection,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const commands = useSelectedThreadCommands({
    activePendingUserInput: composer.activePendingUserInput,
    activePendingUserInputAnswers: composer.activePendingUserInputAnswers,
    refreshSelectedThreadGitStatus: gitActions.refreshSelectedThreadGitStatus,
  });
  const router = useRouter();
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const [drawerVisible, setDrawerVisible] = useState(false);
  const environmentId = firstRouteParam(params.environmentId);
  const threadId = firstRouteParam(params.threadId);

  useThreadDetailSubscription(environmentId, threadId);

  /* ─── Native header theming ──────────────────────────────────────── */
  const isDark = useColorScheme() === "dark";
  const iconColor = String(useThemeColor("--color-icon"));
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const secondaryFg = isDark ? "#a3a3a3" : "#525252";

  /* ─── Git status for native header trigger ───────────────────────── */
  const gitStatus = useGitStatus({
    environmentId: selectedThread?.environmentId ?? "",
    cwd: selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  });

  const handleRefreshGitStatus = useCallback(async () => {
    if (!selectedThread) return;
    await gitStatusManager.refresh({
      environmentId: selectedThread.environmentId,
      cwd: selectedThread.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
    });
  }, [selectedThread, selectedThreadProject?.workspaceRoot]);

  /** Wraps thread refresh + git status refresh for pull-to-refresh */
  const handleRefreshAll = useCallback(async () => {
    await commands.onRefresh();
    await handleRefreshGitStatus();
  }, [commands, handleRefreshGitStatus]);

  const routeThread = useMemo(() => {
    if (!environmentId || !threadId) {
      return null;
    }

    return (
      threads.find((thread) => thread.environmentId === environmentId && thread.id === threadId) ??
      null
    );
  }, [environmentId, threadId, threads]);

  const selectedMatchesRoute =
    selectedThread?.environmentId === environmentId && selectedThread?.id === threadId;

  useEffect(() => {
    if (!routeThread) {
      return;
    }

    if (selectedMatchesRoute) {
      return;
    }

    onSelectThread(routeThread);
  }, [onSelectThread, routeThread, selectedMatchesRoute]);

  if (!environmentId || !threadId) {
    return <LoadingScreen message="Opening thread…" />;
  }

  if (!routeThread) {
    const stillHydrating =
      isLoadingSavedConnection ||
      connectionState === "connecting" ||
      connectionState === "reconnecting";

    if (stillHydrating) {
      return <LoadingScreen message="Opening thread…" />;
    }

    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        className="bg-screen flex-1"
      >
        <EmptyState
          title="Thread unavailable"
          detail="This thread is not available in the current mobile snapshot."
        />
      </ScrollView>
    );
  }

  if (!selectedMatchesRoute || !selectedThread) {
    return <LoadingScreen message="Opening thread…" />;
  }

  const selectedThreadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const serverConfig =
    selectedEnvironmentRuntime?.serverConfig ??
    firstNonNull(Object.values(environmentStateById).map((runtime) => runtime.serverConfig));

  const headerSubtitle = [screenTitle(serverConfig, null), selectedThread.environmentLabel]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          headerShadowVisible: false,
          headerTintColor: iconColor,
          headerBackTitle: "",
          headerTitle: () => (
            <Pressable
              style={{ alignItems: "center", maxWidth: 200 }}
              onLongPress={() => {
                // TODO: trigger rename modal
              }}
            >
              <RNText
                numberOfLines={1}
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 18,
                  fontWeight: "900",
                  color: foregroundColor,
                  letterSpacing: -0.4,
                }}
              >
                {selectedThread.title}
              </RNText>
              <RNText
                numberOfLines={1}
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 12,
                  fontWeight: "700",
                  color: secondaryFg,
                  letterSpacing: 0.3,
                }}
              >
                {headerSubtitle}
              </RNText>
            </Pressable>
          ),
        }}
      />

      <ThreadGitControls
        currentBranch={selectedThread.branch}
        gitStatus={gitStatus.data}
        gitOperationLabel={gitState.gitOperationLabel}
        onPull={gitActions.onPullSelectedThreadBranch}
        onRunAction={gitActions.onRunSelectedThreadGitAction}
      />

      <View className="flex-1 bg-screen">
        <ThreadDetailScreen
          selectedThread={selectedThread}
          screenTone={connectionTone(connectionState)}
          connectionError={connectionError}
          httpBaseUrl={selectedEnvironmentConnection?.httpBaseUrl ?? null}
          bearerToken={selectedEnvironmentConnection?.bearerToken ?? null}
          selectedThreadFeed={composer.selectedThreadFeed}
          activeWorkDurationLabel={composer.activeWorkDurationLabel}
          activePendingApproval={composer.activePendingApproval}
          respondingApprovalId={commands.respondingApprovalId}
          activePendingUserInput={composer.activePendingUserInput}
          activePendingUserInputDrafts={composer.activePendingUserInputDrafts}
          activePendingUserInputAnswers={composer.activePendingUserInputAnswers}
          respondingUserInputId={commands.respondingUserInputId}
          draftMessage={composer.draftMessage}
          draftAttachments={composer.draftAttachments}
          connectionStateLabel={connectionState}
          activeThreadBusy={composer.activeThreadBusy}
          projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          onOpenDrawer={() => setDrawerVisible(true)}
          onOpenConnectionEditor={() => router.push("/connections")}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftImages={composer.onPickDraftImages}
          onNativePasteImages={composer.onNativePasteImages}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          onRefresh={handleRefreshAll}
          serverConfig={serverConfig}
          onStopThread={commands.onStopThread}
          onSendMessage={composer.onSendMessage}
          onUpdateThreadModelSelection={commands.onUpdateThreadModelSelection}
          onUpdateThreadRuntimeMode={commands.onUpdateThreadRuntimeMode}
          onUpdateThreadInteractionMode={commands.onUpdateThreadInteractionMode}
          onRespondToApproval={commands.onRespondToApproval}
          onSelectUserInputOption={composer.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={composer.onChangeUserInputCustomAnswer}
          onSubmitUserInput={commands.onSubmitUserInput}
        />

        <ThreadNavigationDrawer
          visible={drawerVisible}
          projects={projects}
          threads={threads}
          selectedThreadKey={selectedThreadKey}
          onClose={() => setDrawerVisible(false)}
          onSelectThread={(thread) => {
            onSelectThread(thread);
            router.replace(buildThreadRoutePath(thread));
          }}
          onStartNewTask={() => router.push("/new")}
        />
      </View>
    </>
  );
}

import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, useColorScheme, View } from "react-native";

import { useRemoteApp } from "../../state/remote-app-state-provider";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadRoutePath, dismissRoute } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { makeAppPalette } from "../../lib/theme";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import { ThreadNavigationDrawer } from "./ThreadNavigationDrawer";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

export function ThreadRouteScreen() {
  const app = useRemoteApp();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDarkMode = colorScheme !== "light";
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const [drawerVisible, setDrawerVisible] = useState(false);
  const environmentId = firstRouteParam(params.environmentId);
  const threadId = firstRouteParam(params.threadId);

  const routeThread = useMemo(() => {
    if (!environmentId || !threadId) {
      return null;
    }

    return (
      app.threads.find(
        (thread) => thread.environmentId === environmentId && thread.id === threadId,
      ) ?? null
    );
  }, [app.threads, environmentId, threadId]);

  const selectedMatchesRoute =
    app.selectedThread?.environmentId === environmentId && app.selectedThread?.id === threadId;

  useEffect(() => {
    if (!routeThread) {
      return;
    }

    if (selectedMatchesRoute) {
      return;
    }

    app.onSelectThread(routeThread);
  }, [app, routeThread, selectedMatchesRoute]);

  if (!environmentId || !threadId) {
    return <LoadingScreen message="Opening thread…" />;
  }

  if (!routeThread) {
    const stillHydrating =
      app.isLoadingSavedConnection ||
      app.connectionState === "connecting" ||
      app.connectionState === "reconnecting";

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
        style={{ flex: 1, backgroundColor: makeAppPalette(isDarkMode).screenBackground }}
      >
        <EmptyState
          title="Thread unavailable"
          detail="This thread is not available in the current mobile snapshot."
        />
      </ScrollView>
    );
  }

  if (!selectedMatchesRoute || !app.selectedThread) {
    return <LoadingScreen message="Opening thread…" />;
  }

  const selectedThreadKey = scopedThreadKey(
    app.selectedThread.environmentId,
    app.selectedThread.id,
  );

  return (
    <View style={{ flex: 1 }}>
      <ThreadDetailScreen
        selectedThread={app.selectedThread}
        screenTone={app.screenTone}
        connectionError={app.connectionError}
        httpBaseUrl={app.selectedEnvironmentBaseUrl}
        bearerToken={app.selectedEnvironmentBearerToken}
        selectedThreadFeed={app.selectedThreadFeed}
        activeWorkDurationLabel={app.activeWorkDurationLabel}
        activePendingApproval={app.activePendingApproval}
        respondingApprovalId={app.respondingApprovalId}
        activePendingUserInput={app.activePendingUserInput}
        activePendingUserInputDrafts={app.activePendingUserInputDrafts}
        activePendingUserInputAnswers={app.activePendingUserInputAnswers}
        respondingUserInputId={app.respondingUserInputId}
        draftMessage={app.draftMessage}
        draftAttachments={app.draftAttachments}
        connectionStateLabel={app.connectionState}
        activeThreadBusy={app.activeThreadBusy}
        selectedThreadGitStatus={app.selectedThreadGitStatus}
        gitOperationLabel={app.gitOperationLabel}
        selectedThreadQueueCount={app.selectedThreadQueueCount}
        onBack={() => dismissRoute(router)}
        onOpenDrawer={() => setDrawerVisible(true)}
        onOpenConnectionEditor={() => router.push("/connections")}
        onChangeDraftMessage={app.onChangeDraftMessage}
        onPickDraftImages={app.onPickDraftImages}
        onPasteIntoDraft={app.onPasteIntoDraft}
        onRemoveDraftImage={app.onRemoveDraftImage}
        onRefresh={app.onRefresh}
        onRefreshSelectedThreadGitStatus={app.onRefreshSelectedThreadGitStatus}
        onListSelectedThreadBranches={app.onListSelectedThreadBranches}
        onCheckoutSelectedThreadBranch={app.onCheckoutSelectedThreadBranch}
        onCreateSelectedThreadBranch={app.onCreateSelectedThreadBranch}
        onCreateSelectedThreadWorktree={app.onCreateSelectedThreadWorktree}
        onPullSelectedThreadBranch={app.onPullSelectedThreadBranch}
        onRunSelectedThreadGitAction={app.onRunSelectedThreadGitAction}
        onRenameThread={app.onRenameThread}
        onStopThread={app.onStopThread}
        onSendMessage={app.onSendMessage}
        onRespondToApproval={app.onRespondToApproval}
        onSelectUserInputOption={app.onSelectUserInputOption}
        onChangeUserInputCustomAnswer={app.onChangeUserInputCustomAnswer}
        onSubmitUserInput={app.onSubmitUserInput}
      />

      <ThreadNavigationDrawer
        visible={drawerVisible}
        projects={app.projects}
        threads={app.threads}
        selectedThreadKey={selectedThreadKey}
        onClose={() => setDrawerVisible(false)}
        onSelectThread={(thread) => {
          app.onSelectThread(thread);
          router.replace(buildThreadRoutePath(thread));
        }}
        onStartNewTask={() => router.push("/new")}
      />
    </View>
  );
}

import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, useColorScheme, View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadRoutePath, dismissRoute } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { makeAppPalette } from "../../lib/theme";
import { connectionTone } from "../connection/connectionTone";
import { firstNonNull } from "../../state/remote-runtime-types";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";
import { useSelectedThreadCommands } from "../../state/use-selected-thread-commands";
import { useSelectedThreadGit } from "../../state/use-selected-thread-git";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import { ThreadNavigationDrawer } from "./ThreadNavigationDrawer";

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
    selectedEnvironmentConnection,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const composer = useThreadComposerState();
  const git = useSelectedThreadGit();
  const commands = useSelectedThreadCommands({
    activePendingUserInput: composer.activePendingUserInput,
    activePendingUserInputAnswers: composer.activePendingUserInputAnswers,
    refreshSelectedThreadGitStatus: git.refreshSelectedThreadGitStatus,
  });
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
        style={{ flex: 1, backgroundColor: makeAppPalette(isDarkMode).screenBackground }}
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

  return (
    <View style={{ flex: 1 }}>
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
        selectedThreadGitStatus={git.selectedThreadGitStatus}
        gitOperationLabel={git.gitOperationLabel}
        selectedThreadQueueCount={composer.selectedThreadQueueCount}
        onBack={() => dismissRoute(router)}
        onOpenDrawer={() => setDrawerVisible(true)}
        onOpenConnectionEditor={() => router.push("/connections")}
        onChangeDraftMessage={composer.onChangeDraftMessage}
        onPickDraftImages={composer.onPickDraftImages}
        onNativePasteImages={composer.onNativePasteImages}
        onRemoveDraftImage={composer.onRemoveDraftImage}
        onRefresh={commands.onRefresh}
        onRefreshSelectedThreadGitStatus={async (options) => {
          await git.refreshSelectedThreadGitStatus(options);
        }}
        onListSelectedThreadBranches={git.onListSelectedThreadBranches}
        onCheckoutSelectedThreadBranch={git.onCheckoutSelectedThreadBranch}
        onCreateSelectedThreadBranch={git.onCreateSelectedThreadBranch}
        onCreateSelectedThreadWorktree={git.onCreateSelectedThreadWorktree}
        onPullSelectedThreadBranch={git.onPullSelectedThreadBranch}
        onRunSelectedThreadGitAction={git.onRunSelectedThreadGitAction}
        serverConfig={serverConfig}
        onRenameThread={commands.onRenameThread}
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
  );
}

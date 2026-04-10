import { useState } from "react";
import { StatusBar, View } from "react-native";

import { ConnectionSheet } from "../features/connection/ConnectionSheet";
import { HomeScreen } from "../features/home/HomeScreen";
import { NewTaskSheet } from "../features/threads/NewTaskSheet";
import { ThreadDetailScreen } from "../features/threads/ThreadDetailScreen";
import { ThreadNavigationDrawer } from "../features/threads/ThreadNavigationDrawer";
import { scopedThreadKey } from "../lib/scopedEntities";
import type { RemoteAppModel } from "./useRemoteAppState";

export function MobileAppShell(props: {
  readonly app: RemoteAppModel;
  readonly isDarkMode: boolean;
}) {
  const { app } = props;
  const [threadsSheetVisible, setThreadsSheetVisible] = useState(false);
  const [newTaskVisible, setNewTaskVisible] = useState(false);
  const backgroundColor = props.isDarkMode ? "#020617" : "#f6f4ef";

  const selectedThreadKey = app.selectedThread
    ? scopedThreadKey(app.selectedThread.environmentId, app.selectedThread.id)
    : null;

  const selectedThreadDetailProps = app.selectedThread
    ? {
        selectedThread: app.selectedThread,
        screenTone: app.screenTone,
        connectionError: app.connectionError,
        httpBaseUrl: app.selectedEnvironmentBaseUrl,
        bearerToken: app.selectedEnvironmentBearerToken,
        selectedThreadFeed: app.selectedThreadFeed,
        activeWorkDurationLabel: app.activeWorkDurationLabel,
        activePendingApproval: app.activePendingApproval,
        respondingApprovalId: app.respondingApprovalId,
        activePendingUserInput: app.activePendingUserInput,
        activePendingUserInputDrafts: app.activePendingUserInputDrafts,
        activePendingUserInputAnswers: app.activePendingUserInputAnswers,
        respondingUserInputId: app.respondingUserInputId,
        draftMessage: app.draftMessage,
        draftAttachments: app.draftAttachments,
        connectionStateLabel: app.connectionState,
        activeThreadBusy: app.activeThreadBusy,
        selectedThreadGitStatus: app.selectedThreadGitStatus,
        gitOperationLabel: app.gitOperationLabel,
        selectedThreadQueueCount: app.selectedThreadQueueCount,
        onBack: app.onBackFromThread,
        onOpenDrawer: () => setThreadsSheetVisible(true),
        onOpenConnectionEditor: app.onOpenConnectionEditor,
        onChangeDraftMessage: app.onChangeDraftMessage,
        onPickDraftImages: app.onPickDraftImages,
        onPasteIntoDraft: app.onPasteIntoDraft,
        onRemoveDraftImage: app.onRemoveDraftImage,
        onRefresh: app.onRefresh,
        onRefreshSelectedThreadGitStatus: app.onRefreshSelectedThreadGitStatus,
        onListSelectedThreadBranches: app.onListSelectedThreadBranches,
        onCheckoutSelectedThreadBranch: app.onCheckoutSelectedThreadBranch,
        onCreateSelectedThreadBranch: app.onCreateSelectedThreadBranch,
        onCreateSelectedThreadWorktree: app.onCreateSelectedThreadWorktree,
        onPullSelectedThreadBranch: app.onPullSelectedThreadBranch,
        onRunSelectedThreadGitAction: app.onRunSelectedThreadGitAction,
        onRenameThread: app.onRenameThread,
        onStopThread: app.onStopThread,
        onSendMessage: app.onSendMessage,
        onRespondToApproval: app.onRespondToApproval,
        onSelectUserInputOption: app.onSelectUserInputOption,
        onChangeUserInputCustomAnswer: app.onChangeUserInputCustomAnswer,
        onSubmitUserInput: app.onSubmitUserInput,
      }
    : null;

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar
        barStyle={props.isDarkMode ? "light-content" : "dark-content"}
        backgroundColor={backgroundColor}
        translucent
      />

      {app.selectedThread && selectedThreadDetailProps ? (
        <ThreadDetailScreen {...selectedThreadDetailProps} />
      ) : (
        <HomeScreen
          projects={app.projects}
          threads={app.threads}
          connectionState={app.connectionState}
          connectionPulse={app.hasRemoteActivity}
          onOpenConnectionEditor={app.onOpenConnectionEditor}
          onOpenNewTask={() => setNewTaskVisible(true)}
          onSelectThread={app.onSelectThread}
        />
      )}

      <ConnectionSheet
        visible={app.connectionSheetRequired}
        connectedEnvironments={app.connectedEnvironments}
        connectionInput={app.connectionInput}
        connectionState={app.connectionState}
        connectionError={app.connectionError}
        onRequestClose={app.onRequestCloseConnectionEditor}
        onChangePairingUrl={app.onChangeConnectionPairingUrl}
        onConnect={app.onConnectPress}
        onUpdateEnvironment={app.onUpdateEnvironment}
        onRemoveEnvironment={app.onRemoveEnvironmentPress}
      />

      <ThreadNavigationDrawer
        visible={threadsSheetVisible}
        projects={app.projects}
        threads={app.threads}
        selectedThreadKey={selectedThreadKey}
        onClose={() => setThreadsSheetVisible(false)}
        onSelectThread={app.onSelectThread}
        onStartNewTask={() => setNewTaskVisible(true)}
      />

      {newTaskVisible ? (
        <NewTaskSheet
          visible={newTaskVisible}
          projects={app.projects}
          threads={app.threads}
          serverConfigByEnvironmentId={app.serverConfigByEnvironmentId}
          onRequestClose={() => setNewTaskVisible(false)}
          onCreateThreadWithOptions={app.onCreateThreadWithOptions}
          onListProjectBranches={app.onListProjectBranches}
        />
      ) : null}
    </View>
  );
}

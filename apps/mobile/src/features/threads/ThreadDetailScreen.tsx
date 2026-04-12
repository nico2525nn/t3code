import type {
  ApprovalRequestId,
  GitBranch,
  GitRunStackedActionResult,
  GitStatusResult,
  ModelSelection,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import type { GitActionRequestInput } from "@t3tools/client-runtime";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, useColorScheme, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardAvoidingView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { runOnJS } from "react-native-reanimated";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { GlassSafeAreaView } from "../../components/GlassSafeAreaView";
import type { StatusTone } from "../../components/StatusPill";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { MobileLayoutVariant } from "../../lib/mobileLayout";
import type { ScopedMobileThread } from "../../lib/scopedEntities";
import { makeAppPalette } from "../../lib/theme";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { ThreadGitControls } from "./ThreadGitControls";
import { PendingUserInputCard } from "./PendingUserInputCard";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";
import { screenTitle } from "./threadPresentation";

export interface ThreadDetailScreenProps {
  readonly selectedThread: ScopedMobileThread;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly httpBaseUrl: string | null;
  readonly bearerToken: string | null;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly activeWorkDurationLabel: string | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly connectionStateLabel: "ready" | "connecting" | "reconnecting" | "disconnected" | "idle";
  readonly activeThreadBusy: boolean;
  readonly selectedThreadGitStatus: GitStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly selectedThreadQueueCount: number;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: MobileLayoutVariant;
  readonly onBack: () => void;
  readonly onOpenDrawer: () => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onRefreshSelectedThreadGitStatus: (options?: {
    readonly quiet?: boolean;
  }) => Promise<void>;
  readonly onListSelectedThreadBranches: () => Promise<ReadonlyArray<GitBranch>>;
  readonly onCheckoutSelectedThreadBranch: (branch: string) => Promise<void>;
  readonly onCreateSelectedThreadBranch: (branch: string) => Promise<void>;
  readonly onCreateSelectedThreadWorktree: (input: {
    readonly baseBranch: string;
    readonly newBranch: string;
  }) => Promise<void>;
  readonly onPullSelectedThreadBranch: () => Promise<void>;
  readonly onRunSelectedThreadGitAction: (
    input: GitActionRequestInput,
  ) => Promise<GitRunStackedActionResult | null>;
  readonly onRenameThread: (title: string) => Promise<void>;
  readonly onStopThread: () => Promise<void>;
  readonly onSendMessage: () => void;
  readonly onUpdateThreadModelSelection: (modelSelection: ModelSelection) => Promise<void>;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => Promise<void>;
  readonly onUpdateThreadInteractionMode: (
    interactionMode: ProviderInteractionMode,
  ) => Promise<void>;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly onSelectUserInputOption: (requestId: string, questionId: string, label: string) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: string,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<void>;
  readonly showHeader?: boolean;
  readonly showContent?: boolean;
}

function latestStreamingAssistantMessage(
  feed: ReadonlyArray<ThreadFeedEntry>,
): { readonly id: string; readonly textLength: number } | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.message.streaming) {
      continue;
    }
    return {
      id: entry.message.id,
      textLength: entry.message.text.length,
    };
  }

  return null;
}

function useStreamingHaptics(threadId: string, feed: ReadonlyArray<ThreadFeedEntry>) {
  const lastStreamingAssistantRef = useRef<{
    readonly id: string;
    readonly textLength: number;
  } | null>(null);
  const lastStreamHapticAtRef = useRef(0);
  const hydratedRef = useRef(false);
  const previousThreadIdRef = useRef(threadId);

  useEffect(() => {
    if (previousThreadIdRef.current !== threadId) {
      previousThreadIdRef.current = threadId;
      hydratedRef.current = false;
    }

    const latestStreamingMessage = latestStreamingAssistantMessage(feed);

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastStreamingAssistantRef.current = latestStreamingMessage;
      return;
    }

    if (!latestStreamingMessage) {
      lastStreamingAssistantRef.current = null;
      return;
    }

    const previousStreamingMessage = lastStreamingAssistantRef.current;
    lastStreamingAssistantRef.current = latestStreamingMessage;

    const isNewStream = previousStreamingMessage?.id !== latestStreamingMessage.id;
    const textGrew =
      previousStreamingMessage?.id === latestStreamingMessage.id &&
      latestStreamingMessage.textLength > previousStreamingMessage.textLength;

    if (!isNewStream && !textGrew) {
      return;
    }

    const now = Date.now();
    if (!isNewStream && now - lastStreamHapticAtRef.current < 320) {
      return;
    }

    lastStreamHapticAtRef.current = now;
    void Haptics.selectionAsync();
  }, [threadId, feed]);
}

export function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const { onOpenDrawer, onRefresh, onRefreshSelectedThreadGitStatus } = props;
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const insets = useSafeAreaInsets();
  const agentLabel = `${props.selectedThread.modelSelection.provider} agent`;
  const headerOverlayHeight = insets.top + 118;
  const composerBottomInset = Math.max(insets.bottom, 12);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  const [renameVisible, setRenameVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [renameDraft, setRenameDraft] = useState(props.selectedThread.title);
  const showHeader = props.showHeader ?? true;
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);

  const completeDrawerGesture = useCallback(() => {
    void Haptics.selectionAsync();
    onOpenDrawer();
  }, [onOpenDrawer]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) {
      return;
    }

    setRefreshing(true);
    try {
      await onRefresh();
      await onRefreshSelectedThreadGitStatus();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, onRefreshSelectedThreadGitStatus, refreshing]);

  const headerDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isSplitLayout)
        .hitSlop({ left: 0, width: 40 })
        .activeOffsetX([10, 999])
        .failOffsetY([-24, 24])
        .onEnd((event) => {
          const translationX = Math.max(event.translationX, 0);
          if (event.y < headerOverlayHeight && translationX > 56) {
            runOnJS(completeDrawerGesture)();
          }
        }),
    [completeDrawerGesture, headerOverlayHeight, isSplitLayout],
  );

  async function handleSubmitRename(): Promise<void> {
    const trimmed = renameDraft.trim();
    if (trimmed.length === 0) {
      return;
    }

    await props.onRenameThread(trimmed);
    setRenameVisible(false);
  }

  return (
    <GestureDetector gesture={headerDrawerGesture}>
      <View style={{ flex: 1, backgroundColor: palette.screenBackground }}>
        {showHeader ? (
          <View className="absolute inset-x-0 top-0 z-20">
            <View
              style={{
                backgroundColor: palette.headerBackground,
                borderBottomWidth: 1,
                borderBottomColor: palette.headerBorder,
              }}
            >
              <GlassSafeAreaView
                leftSlot={
                  isSplitLayout ? null : (
                    <Pressable
                      className="h-11 w-11 items-center justify-center rounded-full"
                      style={{
                        backgroundColor: palette.subtleBg,
                      }}
                      onPress={props.onBack}
                    >
                      <SymbolView
                        name="chevron.left"
                        size={18}
                        tintColor={palette.icon}
                        type="monochrome"
                      />
                    </Pressable>
                  )
                }
                centerSlot={
                  <View style={{ alignItems: "center", gap: 2, width: "100%" }}>
                    <Pressable
                      style={{ maxWidth: "100%" }}
                      onLongPress={() => {
                        setRenameDraft(props.selectedThread.title);
                        setRenameVisible(true);
                      }}
                    >
                      <Animated.Text
                        numberOfLines={1}
                        style={{
                          color: palette.text,
                          fontSize: 17,
                          fontWeight: "800",
                          lineHeight: 22,
                          textAlign: "center",
                        }}
                      >
                        {props.selectedThread.title}
                      </Animated.Text>
                    </Pressable>
                    <Text
                      className="text-[11px] font-t3-medium"
                      numberOfLines={1}
                      style={{ color: palette.textMuted, letterSpacing: 0.3, textAlign: "center" }}
                    >
                      {[
                        screenTitle(props.serverConfig, null),
                        props.selectedThread.environmentLabel,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                }
                rightSlot={
                  <ThreadGitControls
                    currentBranch={props.selectedThread.branch}
                    currentWorktreePath={props.selectedThread.worktreePath}
                    gitStatus={props.selectedThreadGitStatus}
                    gitOperationLabel={props.gitOperationLabel}
                    onRefreshStatus={props.onRefreshSelectedThreadGitStatus}
                    onListBranches={props.onListSelectedThreadBranches}
                    onCheckoutBranch={props.onCheckoutSelectedThreadBranch}
                    onCreateBranch={props.onCreateSelectedThreadBranch}
                    onCreateWorktree={props.onCreateSelectedThreadWorktree}
                    onPull={props.onPullSelectedThreadBranch}
                    onRunAction={props.onRunSelectedThreadGitAction}
                  />
                }
              />
            </View>
          </View>
        ) : null}

        {/* Feed area — KAV shrinks this when keyboard opens */}
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          {showContent ? (
            <View style={{ flex: 1, minHeight: 0 }}>
              <ThreadFeed
                threadId={props.selectedThread.id}
                feed={props.selectedThreadFeed}
                httpBaseUrl={props.httpBaseUrl}
                bearerToken={props.bearerToken}
                agentLabel={agentLabel}
                contentTopInset={headerOverlayHeight + 20}
                contentBottomInset={composerOverlapHeight + 8}
                layoutVariant={layoutVariant}
                composerExpanded={composerExpanded}
                refreshing={refreshing}
                onRefresh={() => void handleRefresh()}
              />
            </View>
          ) : (
            <View style={{ flex: 1 }} />
          )}
        </KeyboardAvoidingView>

        {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
        {showContent ? (
          <KeyboardStickyView
            style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
            offset={{ closed: 0, opened: 0 }}
          >
            {props.activePendingApproval || props.activePendingUserInput ? (
              <View className="gap-3 px-4 pb-3" style={{ flexShrink: 0 }}>
                {props.activePendingApproval ? (
                  <PendingApprovalCard
                    approval={props.activePendingApproval}
                    respondingApprovalId={props.respondingApprovalId}
                    onRespond={props.onRespondToApproval}
                  />
                ) : null}
                {props.activePendingUserInput ? (
                  <PendingUserInputCard
                    pendingUserInput={props.activePendingUserInput}
                    drafts={props.activePendingUserInputDrafts}
                    answers={props.activePendingUserInputAnswers}
                    respondingUserInputId={props.respondingUserInputId}
                    onSelectOption={props.onSelectUserInputOption}
                    onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                    onSubmit={props.onSubmitUserInput}
                  />
                ) : null}
              </View>
            ) : null}

            <ThreadComposer
              draftMessage={props.draftMessage}
              draftAttachments={props.draftAttachments}
              placeholder="Ask the repo agent, or run a command…"
              connectionState={props.connectionStateLabel}
              selectedThread={props.selectedThread}
              serverConfig={props.serverConfig}
              queueCount={props.selectedThreadQueueCount}
              activeThreadBusy={props.activeThreadBusy}
              layoutVariant={layoutVariant}
              bottomInset={composerBottomInset}
              onChangeDraftMessage={props.onChangeDraftMessage}
              onPickDraftImages={props.onPickDraftImages}
              onNativePasteImages={props.onNativePasteImages}
              onRemoveDraftImage={props.onRemoveDraftImage}
              onRefresh={props.onRefresh}
              onStopThread={props.onStopThread}
              onSendMessage={props.onSendMessage}
              onUpdateModelSelection={props.onUpdateThreadModelSelection}
              onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
              onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
              onExpandedChange={setComposerExpanded}
            />
          </KeyboardStickyView>
        ) : null}

        <Modal
          transparent
          animationType="fade"
          visible={renameVisible}
          onRequestClose={() => setRenameVisible(false)}
        >
          <View
            className="flex-1 items-center justify-center px-5"
            style={{ backgroundColor: palette.backdrop }}
          >
            <View
              className="w-full gap-4 px-4 py-4"
              style={{
                maxWidth: 420,
                borderWidth: 1,
                borderColor: palette.border,
                backgroundColor: palette.card,
              }}
            >
              <View className="gap-2">
                <Text
                  className="text-[11px] font-bold uppercase"
                  style={{ color: palette.textMuted, letterSpacing: 1.2 }}
                >
                  Thread name
                </Text>
                <Text
                  className="text-[20px] font-extrabold leading-[24px]"
                  style={{ color: palette.text }}
                >
                  Rename thread
                </Text>
              </View>

              <TextInput
                value={renameDraft}
                onChangeText={setRenameDraft}
                placeholder="Thread title"
                className="min-h-[56px] px-4 py-3 text-[15px]"
                style={{
                  borderWidth: 1,
                  borderColor: palette.border,
                  backgroundColor: palette.inputBackground,
                  color: palette.text,
                }}
                onSubmitEditing={() => {
                  void handleSubmitRename();
                }}
              />

              <View className="flex-row gap-3">
                <Pressable
                  className="min-h-[48px] flex-1 items-center justify-center px-4 py-3"
                  style={{
                    borderWidth: 1,
                    borderColor: palette.border,
                    backgroundColor: palette.secondaryButton,
                  }}
                  onPress={() => {
                    setRenameDraft(props.selectedThread.title);
                    setRenameVisible(false);
                  }}
                >
                  <Text
                    className="text-sm font-extrabold uppercase"
                    style={{ color: palette.text, letterSpacing: 1 }}
                  >
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  className="min-h-[48px] flex-1 items-center justify-center px-4 py-3"
                  style={{ backgroundColor: palette.primaryButton }}
                  onPress={() => {
                    void handleSubmitRename();
                  }}
                >
                  <Text
                    className="text-sm font-extrabold uppercase"
                    style={{ color: palette.primaryButtonText, letterSpacing: 1 }}
                  >
                    Save
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </GestureDetector>
  );
}

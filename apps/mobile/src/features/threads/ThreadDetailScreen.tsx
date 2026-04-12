import type {
  ApprovalRequestId,
  GitBranch,
  GitRunStackedActionResult,
  GitStatusResult,
  ProviderApprovalDecision,
} from "@t3tools/contracts";
import type { GitActionRequestInput } from "@t3tools/client-runtime";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

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
import { ThreadComposer } from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";

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
  readonly layoutVariant?: MobileLayoutVariant;
  readonly onBack: () => void;
  readonly onOpenDrawer: () => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onPasteIntoDraft: () => Promise<void>;
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
  const { onBack, onOpenDrawer, onRefresh, onRefreshSelectedThreadGitStatus } = props;
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const agentLabel = `${props.selectedThread.modelSelection.provider} agent`;
  const headerOverlayHeight = insets.top + 118;
  const composerBottomInset = Math.max(insets.bottom, 12);
  const [renameVisible, setRenameVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [renameDraft, setRenameDraft] = useState(props.selectedThread.title);
  const showHeader = props.showHeader ?? true;
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const edgeSwipeTranslation = useSharedValue(0);

  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);

  const completeDrawerGesture = useCallback(() => {
    void Haptics.selectionAsync();
    onOpenDrawer();
  }, [onOpenDrawer]);

  const completeBackGesture = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onBack();
  }, [onBack]);

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

  const edgeSwipeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isSplitLayout)
        .hitSlop({ left: 0, width: 40 })
        .activeOffsetX([10, 999])
        .failOffsetY([-24, 24])
        .onUpdate((event) => {
          edgeSwipeTranslation.value = Math.max(event.translationX, 0);
        })
        .onEnd((event) => {
          const translationX = Math.max(event.translationX, 0);
          const shouldOpenDrawer = event.y < headerOverlayHeight && translationX > 56;
          const shouldGoBack = translationX > Math.min(width * 0.26, 120);

          if (shouldOpenDrawer) {
            edgeSwipeTranslation.value = withSpring(0, {
              damping: 20,
              stiffness: 220,
            });
            runOnJS(completeDrawerGesture)();
            return;
          }

          if (shouldGoBack) {
            edgeSwipeTranslation.value = withTiming(width, { duration: 180 }, (finished) => {
              if (!finished) {
                return;
              }

              edgeSwipeTranslation.value = 0;
              runOnJS(completeBackGesture)();
            });
            return;
          }

          edgeSwipeTranslation.value = withSpring(0, {
            damping: 20,
            stiffness: 220,
          });
        }),
    [
      completeBackGesture,
      completeDrawerGesture,
      edgeSwipeTranslation,
      headerOverlayHeight,
      isSplitLayout,
      width,
    ],
  );

  const edgeSwipeStyle = useAnimatedStyle(() => {
    const borderRadius = interpolate(edgeSwipeTranslation.value, [0, width], [0, 28], "clamp");

    return {
      flex: 1,
      transform: [{ translateX: edgeSwipeTranslation.value }],
      borderTopLeftRadius: borderRadius,
      borderBottomLeftRadius: borderRadius,
      overflow: "hidden",
    };
  });

  async function handleSubmitRename(): Promise<void> {
    const trimmed = renameDraft.trim();
    if (trimmed.length === 0) {
      return;
    }

    await props.onRenameThread(trimmed);
    setRenameVisible(false);
  }

  return (
    <GestureDetector gesture={edgeSwipeGesture}>
      <Animated.View style={edgeSwipeStyle}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1, backgroundColor: palette.screenBackground }}
        >
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
                    <View className="items-center gap-1">
                      <Pressable
                        onLongPress={() => {
                          setRenameDraft(props.selectedThread.title);
                          setRenameVisible(true);
                        }}
                      >
                        <Animated.Text
                          numberOfLines={1}
                          style={{
                            color: palette.text,
                            fontSize: 18,
                            fontWeight: "800",
                            lineHeight: 22,
                          }}
                        >
                          {props.selectedThread.title}
                        </Animated.Text>
                      </Pressable>
                      <Text
                        className="text-[11px] font-bold uppercase"
                        style={{ color: palette.textMuted, letterSpacing: 1.05 }}
                      >
                        {props.activeWorkDurationLabel ? props.activeWorkDurationLabel : ""}
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

          {showContent ? (
            <>
              <View style={{ flex: 1, minHeight: 0 }}>
                <ThreadFeed
                  threadId={props.selectedThread.id}
                  feed={props.selectedThreadFeed}
                  httpBaseUrl={props.httpBaseUrl}
                  bearerToken={props.bearerToken}
                  agentLabel={agentLabel}
                  contentTopInset={headerOverlayHeight + 20}
                  contentBottomInset={composerBottomInset + 20}
                  layoutVariant={layoutVariant}
                  refreshing={refreshing}
                  onRefresh={() => void handleRefresh()}
                />
              </View>

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
                queueCount={props.selectedThreadQueueCount}
                activeThreadBusy={props.activeThreadBusy}
                layoutVariant={layoutVariant}
                bottomInset={composerBottomInset}
                onChangeDraftMessage={props.onChangeDraftMessage}
                onPickDraftImages={props.onPickDraftImages}
                onPasteIntoDraft={props.onPasteIntoDraft}
                onRemoveDraftImage={props.onRemoveDraftImage}
                onRefresh={props.onRefresh}
                onStopThread={props.onStopThread}
                onSendMessage={props.onSendMessage}
              />
            </>
          ) : (
            <View style={{ flex: 1 }} />
          )}

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
        </KeyboardAvoidingView>
      </Animated.View>
    </GestureDetector>
  );
}

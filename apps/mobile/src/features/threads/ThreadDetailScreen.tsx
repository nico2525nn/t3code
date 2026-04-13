import type {
  ApprovalRequestId,
  ModelSelection,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardAvoidingView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { runOnJS } from "react-native-reanimated";

import type { StatusTone } from "../../components/StatusPill";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { MobileLayoutVariant } from "../../lib/mobileLayout";
import type { ScopedMobileThread } from "../../lib/scopedEntities";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  ThreadComposer,
} from "./ThreadComposer";
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
  readonly projectWorkspaceRoot: string | null;
  readonly selectedThreadQueueCount: number;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: MobileLayoutVariant;
  readonly onOpenDrawer: () => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onRefresh: () => Promise<void>;
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
  const { onOpenDrawer, onRefresh } = props;

  const insets = useSafeAreaInsets();
  const agentLabel = `${props.selectedThread.modelSelection.provider} agent`;
  const composerBottomInset = Math.max(insets.bottom, 12);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  const [refreshing, setRefreshing] = useState(false);
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
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing]);

  const drawerGestureThreshold = 80;
  const headerDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isSplitLayout)
        .hitSlop({ left: 0, width: 40 })
        .activeOffsetX([10, 999])
        .failOffsetY([-24, 24])
        .onEnd((event) => {
          const translationX = Math.max(event.translationX, 0);
          if (event.y < drawerGestureThreshold && translationX > 56) {
            runOnJS(completeDrawerGesture)();
          }
        }),
    [completeDrawerGesture, isSplitLayout],
  );

  return (
    <GestureDetector gesture={headerDrawerGesture}>
      <View className="flex-1">
        {/* Feed area — KAV shrinks this when keyboard opens */}
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          {showContent ? (
            <ThreadFeed
              threadId={props.selectedThread.id}
              feed={props.selectedThreadFeed}
              httpBaseUrl={props.httpBaseUrl}
              bearerToken={props.bearerToken}
              agentLabel={agentLabel}
              contentBottomInset={composerOverlapHeight + 8}
              layoutVariant={layoutVariant}
              composerExpanded={composerExpanded}
              refreshing={refreshing}
              onRefresh={() => void handleRefresh()}
            />
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
      </View>
    </GestureDetector>
  );
}

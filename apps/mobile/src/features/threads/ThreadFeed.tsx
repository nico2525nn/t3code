import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { FlashList, type FlashListRef, type ListRenderItemInfo } from "@shopify/flash-list";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useEffect, useState, useRef } from "react";
import Markdown from "react-native-markdown-display";
import {
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  useColorScheme,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cx } from "../../lib/classNames";
import type { MobileLayoutVariant } from "../../lib/mobileLayout";
import { makeAppPalette } from "../../lib/theme";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { relativeTime } from "../../lib/time";
import { messageImageUrl } from "./threadPresentation";

export interface ThreadFeedProps {
  readonly threadId: string;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly httpBaseUrl: string | null;
  readonly bearerToken: string | null;
  readonly agentLabel: string;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly layoutVariant?: MobileLayoutVariant;
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeCompactActivityLabel(value: string): string {
  return value.replace(/\s+(?:started|complete|completed)\s*$/i, "").trim();
}

function buildActivityRows(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly createdAt: string;
    readonly summary: string;
    readonly detail: string | null;
    readonly status: string | null;
  }>,
) {
  const rows: Array<{
    id: string;
    createdAt: string;
    summary: string;
    detail: string | null;
    status: string | null;
  }> = [];

  for (const activity of activities) {
    const detail = compactActivityDetail(activity.detail);
    const previous = rows.at(-1);

    if (previous && previous.summary === activity.summary) {
      rows[rows.length - 1] = {
        ...previous,
        createdAt: activity.createdAt,
        detail,
        status: activity.status ?? previous.status,
      };
      continue;
    }

    rows.push({
      id: activity.id,
      createdAt: activity.createdAt,
      summary: activity.summary,
      detail,
      status: activity.status,
    });
  }

  return rows;
}

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

function makeMarkdownStyles(isDarkMode: boolean) {
  const bodyColor = isDarkMode ? "#e2e8f0" : "#020617";
  const strongColor = isDarkMode ? "#f8fafc" : "#020617";
  const linkColor = isDarkMode ? "#7dd3fc" : "#0369a1";
  const blockquoteBorder = isDarkMode
    ? "rgba(148,163,184,0.35)"
    : "rgba(100,116,139,0.35)";
  const codeBg = isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.08)";
  const codeText = isDarkMode ? "#e2e8f0" : "#0f172a";
  const userCodeBg = isDarkMode ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.55)";
  const userCodeText = isDarkMode ? "#e2e8f0" : "#0f172a";
  const userFenceBg = isDarkMode ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.6)";

  const base = {
    body: {
      color: bodyColor,
      fontSize: 15,
      lineHeight: 22,
    },
    paragraph: { marginTop: 0, marginBottom: 0 },
    bullet_list: { marginTop: 0, marginBottom: 0 },
    ordered_list: { marginTop: 0, marginBottom: 0 },
    list_item: { marginTop: 0, marginBottom: 2 },
    strong: { fontWeight: "800" as const, color: strongColor },
    em: { fontStyle: "italic" as const },
    link: { color: linkColor },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: blockquoteBorder,
      paddingLeft: 12,
      marginLeft: 0,
    },
  };

  const user = {
    ...base,
    code_inline: {
      backgroundColor: userCodeBg,
      color: userCodeText,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    code_block: {
      backgroundColor: userFenceBg,
      color: userCodeText,
      borderRadius: 14,
      padding: 12,
    },
    fence: {
      backgroundColor: userFenceBg,
      color: userCodeText,
      borderRadius: 14,
      padding: 12,
    },
  };

  const assistant = {
    ...base,
    code_inline: {
      backgroundColor: codeBg,
      color: codeText,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    code_block: {
      backgroundColor: codeBg,
      color: codeText,
      borderRadius: 14,
      padding: 12,
    },
    fence: {
      backgroundColor: codeBg,
      color: codeText,
      borderRadius: 14,
      padding: 12,
    },
  };

  return { user, assistant };
}

function renderFeedEntry(
  info: ListRenderItemInfo<ThreadFeedEntry>,
  props: Pick<ThreadFeedProps, "bearerToken" | "httpBaseUrl"> & {
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string) => void;
    readonly isDarkMode: boolean;
  },
) {
  const entry = info.item;
  const markdownStyles = makeMarkdownStyles(props.isDarkMode);
  const palette = makeAppPalette(props.isDarkMode);

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = `${relativeTime(message.createdAt)}${message.streaming ? " • live" : ""}`;
    const attachments = message.attachments ?? [];

    if (isUser) {
      return (
        <View className="mb-3.5 items-end gap-1.5">
          <View className="max-w-[85%] gap-2 rounded-[22px] rounded-br-[10px] border border-orange-300/60 bg-orange-100/70 px-4 py-4 dark:border-orange-300/22 dark:bg-orange-300/14">
            {message.text.trim().length > 0 ? (
              <Markdown style={styles}>{message.text}</Markdown>
            ) : null}
            {attachments.map((attachment) => {
              const uri = messageImageUrl(props.httpBaseUrl, attachment.id);
              if (!uri) {
                return null;
              }

              return (
                <Image
                  key={attachment.id}
                  source={{
                    uri,
                    ...(props.bearerToken
                      ? {
                          headers: {
                            Authorization: `Bearer ${props.bearerToken}`,
                          },
                        }
                      : {}),
                  }}
                  className="aspect-[1.3] w-full rounded-[18px] bg-slate-200 dark:bg-slate-800"
                  resizeMode="cover"
                />
              );
            })}
          </View>
          <Text className="px-1 text-right font-t3-medium text-xs text-slate-500 dark:text-slate-500">
            {timestampLabel}
          </Text>
        </View>
      );
    }

    return (
      <View className="mb-3.5 gap-1.5 px-1">
        {message.text.trim().length > 0 ? (
          <Markdown style={styles}>{message.text}</Markdown>
        ) : null}
        {attachments.map((attachment) => {
          const uri = messageImageUrl(props.httpBaseUrl, attachment.id);
          if (!uri) {
            return null;
          }

          return (
            <Image
              key={attachment.id}
              source={{
                uri,
                ...(props.bearerToken
                  ? {
                      headers: {
                        Authorization: `Bearer ${props.bearerToken}`,
                      },
                    }
                  : {}),
              }}
              className="aspect-[1.3] w-full rounded-[18px] bg-slate-200 dark:bg-slate-800"
              resizeMode="cover"
            />
          );
        })}
        <Text className="font-t3-medium text-xs text-slate-500 dark:text-slate-500">
          {timestampLabel}
        </Text>
      </View>
    );
  }

  if (entry.type === "queued-message") {
    return (
      <View className="mb-3.5 gap-1.5 items-end">
        <View className="max-w-[85%] gap-2 rounded-[22px] rounded-br-[10px] border border-sky-300/60 bg-sky-100/75 px-4 py-4 dark:border-sky-300/20 dark:bg-sky-400/10">
          <Text className="font-sans text-[15px] leading-[22px] text-slate-950 dark:text-slate-50">
            {entry.queuedMessage.text}
          </Text>
          {entry.queuedMessage.attachments.length > 0 ? (
            <Text className="font-t3-medium text-xs text-slate-500 dark:text-slate-500">
              {entry.queuedMessage.attachments.length} image
              {entry.queuedMessage.attachments.length === 1 ? "" : "s"} attached
            </Text>
          ) : null}
        </View>
        <Text className="px-1 text-right font-t3-medium text-xs text-slate-500 dark:text-slate-500">
          {entry.sending ? "dispatching" : `${relativeTime(entry.createdAt)} • pending`}
        </Text>
      </View>
    );
  }

  const rows = buildActivityRows(entry.activities);
  const isExpanded = props.expandedWorkGroups[entry.id] ?? false;
  const hasOverflow = rows.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleRows = hasOverflow && !isExpanded ? rows.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const showHeader = hasOverflow;

  return (
    <View className="mb-3 rounded-[20px] border border-slate-200/80 bg-slate-50/85 px-3 py-2 dark:border-white/4 dark:bg-white/[0.025]">
      {showHeader ? (
        <View className="mb-1.5 flex-row items-center justify-between gap-3 px-0.5">
          <Text className="font-t3-bold text-[10px] uppercase tracking-[0.8px] text-slate-500 dark:text-slate-500">
            Tool calls ({rows.length})
          </Text>
          <Pressable onPress={() => props.onToggleWorkGroup(entry.id)}>
            <Text className="font-t3-medium text-[10px] uppercase tracking-[0.8px] text-slate-500 dark:text-slate-500">
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {visibleRows.map((row, index) => (
        <View
          key={row.id}
          className={cx(
            "flex-row items-center gap-2 rounded-lg px-1 py-1",
            index > 0 && "border-t border-slate-200/80 dark:border-white/4",
          )}
        >
          <View className="items-center justify-center pt-0.5">
            <SymbolView name="terminal" size={13} tintColor={palette.iconSubtle} type="monochrome" />
          </View>
          <ScrollView
            horizontal
            nestedScrollEnabled
            directionalLockEnabled
            showsHorizontalScrollIndicator={false}
            bounces={false}
            className="flex-1"
            contentContainerStyle={{ paddingRight: 12 }}
            style={{ flex: 1 }}
          >
            <Text
              className="text-[11px] leading-[18px] text-slate-500 dark:text-slate-500"
              onLongPress={() => {
                const copyValue = row.detail ?? normalizeCompactActivityLabel(row.summary);
                props.onCopyWorkRow(row.id, copyValue);
              }}
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
              }}
            >
              {row.detail
                ? `${normalizeCompactActivityLabel(row.summary)} - ${row.detail}`
                : normalizeCompactActivityLabel(row.summary)}
            </Text>
          </ScrollView>
          {props.copiedRowId === row.id ? (
            <Text className="shrink-0 font-t3-medium text-[10px] uppercase tracking-[0.8px] text-emerald-600 dark:text-emerald-400">
              Copied
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function useAutoScrollToLatest(
  listRef: React.RefObject<FlashListRef<ThreadFeedEntry> | null>,
  threadId: string,
  feed: ReadonlyArray<ThreadFeedEntry>,
) {
  const shouldFollowLatestRef = useRef(true);
  const previousThreadIdRef = useRef(threadId);
  const previousFeedLengthRef = useRef(feed.length);

  const updateFollowLatest = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    shouldFollowLatestRef.current = distanceFromBottom <= 96;
  }, []);

  useEffect(() => {
    const isNewThread = previousThreadIdRef.current !== threadId;
    if (isNewThread) {
      previousThreadIdRef.current = threadId;
      previousFeedLengthRef.current = feed.length;
      shouldFollowLatestRef.current = true;
    }

    const feedGrew = feed.length >= previousFeedLengthRef.current;
    previousFeedLengthRef.current = feed.length;

    if (!shouldFollowLatestRef.current || (!feedGrew && !isNewThread)) {
      return;
    }

    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({
        animated: !isNewThread,
      });
    });
  }, [feed, feed.length, listRef, threadId]);

  return updateFollowLatest;
}

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const isDarkMode = useColorScheme() === "dark";
  const listRef = useRef<FlashListRef<ThreadFeedEntry>>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const updateFollowLatest = useAutoScrollToLatest(listRef, props.threadId, props.feed);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;

  useEffect(() => {
    setCopiedRowId(null);
    setExpandedWorkGroups({});
  }, [props.threadId]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    void Clipboard.setStringAsync(value);
    void Haptics.selectionAsync();
    setCopiedRowId(rowId);
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedRowId((current) => (current === rowId ? null : current));
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((current) => ({
      ...current,
      [groupId]: !(current[groupId] ?? false),
    }));
  }, []);
  const renderItem = useCallback(
    (info: ListRenderItemInfo<ThreadFeedEntry>) =>
      renderFeedEntry(info, {
        bearerToken: props.bearerToken,
        copiedRowId,
        httpBaseUrl: props.httpBaseUrl,
        expandedWorkGroups,
        onCopyWorkRow,
        onToggleWorkGroup,
        isDarkMode,
      }),
    [
      copiedRowId,
      expandedWorkGroups,
      isDarkMode,
      onCopyWorkRow,
      onToggleWorkGroup,
      props.bearerToken,
      props.httpBaseUrl,
    ],
  );

  if (props.feed.length === 0) {
    return (
      <View
        className="flex-1"
        style={{
          minHeight: 0,
          paddingHorizontal: horizontalPadding,
          paddingTop: props.contentTopInset ?? 18,
          paddingBottom: props.contentBottomInset ?? 18,
        }}
      >
        <EmptyState
          title="No conversation yet"
          detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
        />
      </View>
    );
  }

  return (
    <View className="flex-1" style={{ minHeight: 0 }}>
      <FlashList
        ref={listRef}
        key={props.threadId}
        style={{ flex: 1 }}
        data={props.feed}
        renderItem={renderItem}
        keyExtractor={(entry) => `${entry.type}:${entry.id}`}
        keyboardShouldPersistTaps="handled"
        onScroll={updateFollowLatest}
        scrollEventThrottle={16}
        refreshControl={
          props.onRefresh ? (
            <RefreshControl refreshing={props.refreshing ?? false} onRefresh={props.onRefresh} />
          ) : undefined
        }
        maintainVisibleContentPosition={{
          autoscrollToBottomThreshold: 0.2,
          animateAutoScrollToBottom: true,
          startRenderingFromBottom: true,
        }}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: props.contentTopInset ?? 18,
          paddingBottom: props.contentBottomInset ?? 18,
        }}
      />
    </View>
  );
});

import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { resolveThreadListV2Status, type ThreadListV2Status } from "./threadListV2";

/**
 * Thread List v2 rows, ported from the web sidebar v2 (SidebarV2.tsx):
 * brutalist square cards where a thin title bar carries the project
 * favicon + name as chrome, a solid edge strip carries status color, and
 * settled threads collapse to dimmed slim rows.
 */

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const EDGE_CLASS_BY_STATUS: Partial<Record<ThreadListV2Status, string>> = {
  approval: "bg-amber-500 dark:bg-amber-400",
  working: "bg-sky-500 dark:bg-sky-400",
  failed: "bg-red-500",
};

const STATUS_WORD_BY_STATUS: Partial<
  Record<ThreadListV2Status, { label: string; className: string }>
> = {
  approval: { label: "NEEDS APPROVAL", className: "text-amber-600 dark:text-amber-400" },
  working: { label: "WORKING", className: "text-sky-600 dark:text-sky-400" },
  failed: { label: "FAILED", className: "text-red-600 dark:text-red-400" },
};

function threadTimeLabel(thread: EnvironmentThreadShell, status: ThreadListV2Status): string {
  if (status === "approval") {
    return `waiting ${relativeTime(thread.updatedAt)}`;
  }
  return relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt);
}

const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: "Settle", image: "checkmark" },
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const SLIM_MENU_ACTIONS: MenuAction[] = [
  { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export const ThreadListV2SettledDivider = memo(function ThreadListV2SettledDivider() {
  const separatorColor = useThemeColor("--color-separator");
  return (
    <View className="mb-1.5 mt-3 flex-row items-center gap-2 px-5">
      <Text
        className="text-3xs font-t3-bold uppercase text-foreground-tertiary"
        style={{ fontFamily: MONO_FONT, letterSpacing: 1.8 }}
      >
        Settled
      </Text>
      <View className="h-px flex-1" style={{ backgroundColor: separatorColor }} />
    </View>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly showSettledDivider: boolean;
  readonly project: EnvironmentProject | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const {
    thread,
    variant,
    onSelectThread,
    onArchiveThread,
    onDeleteThread,
    onSettleThread,
    onUnsettleThread,
  } = props;

  const separatorColor = useThemeColor("--color-separator");
  const screenColor = useThemeColor("--color-screen");

  const status = resolveThreadListV2Status(thread);
  const statusEdge = EDGE_CLASS_BY_STATUS[status];
  const statusWord = STATUS_WORD_BY_STATUS[status];
  const timeLabel = threadTimeLabel(thread, status);

  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete, handleSettle, handleUnsettle],
  );

  // Swipe: the v2 primary action is Settle (cards) / Un-settle (slim) —
  // the lifecycle transition IS the organizing gesture of this list.
  const primaryAction = useMemo(
    () =>
      variant === "card"
        ? {
            accessibilityLabel: `Settle ${thread.title}`,
            icon: "checkmark" as const,
            label: "Settle",
            onPress: handleSettle,
          }
        : {
            accessibilityLabel: `Un-settle ${thread.title}`,
            icon: "arrow.uturn.backward" as const,
            label: "Un-settle",
            onPress: handleUnsettle,
          },
    [handleSettle, handleUnsettle, thread.title, variant],
  );

  const rowContent = (close: () => void) =>
    variant === "card" ? (
      <Pressable
        accessibilityHint="Opens the thread. Swipe left to settle."
        accessibilityLabel={thread.title}
        accessibilityRole="button"
        className="bg-screen"
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View className="px-4 py-1">
          <View className="overflow-hidden border border-black/12 bg-black/[0.02] dark:border-white/12 dark:bg-white/[0.04]">
            {/* Title bar: project favicon + name as chrome. */}
            <View className="flex-row items-center gap-1.5 border-b border-black/10 bg-black/[0.03] py-1 pl-3 pr-2.5 dark:border-white/10 dark:bg-white/[0.03]">
              {props.project ? (
                <ProjectFavicon
                  environmentId={thread.environmentId}
                  size={14}
                  projectTitle={props.project.title}
                  workspaceRoot={props.project.workspaceRoot}
                />
              ) : null}
              <Text
                className="flex-1 text-3xs font-t3-bold uppercase text-foreground-muted"
                numberOfLines={1}
                style={{ fontFamily: MONO_FONT, letterSpacing: 1.4 }}
              >
                {props.project?.title ?? ""}
              </Text>
              <Text
                className={cn(
                  "text-3xs tabular-nums",
                  status === "approval"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-foreground-tertiary",
                )}
                style={{ fontFamily: MONO_FONT }}
              >
                {timeLabel}
              </Text>
            </View>
            {/* Status edge strip spans the full card over both zones. */}
            {statusEdge ? (
              <View className={cn("absolute bottom-0 left-0 top-0 w-[3px]", statusEdge)} />
            ) : null}
            <View className="px-3 py-2">
              <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
                {thread.title}
              </Text>
              <View className="mt-1 flex-row items-center gap-2">
                {statusWord ? (
                  <Text
                    className={cn("text-3xs font-t3-bold", statusWord.className)}
                    style={{ fontFamily: MONO_FONT, letterSpacing: 0.9 }}
                  >
                    {statusWord.label}
                  </Text>
                ) : null}
                {status === "failed" && thread.session?.lastError ? (
                  <Text
                    className="flex-1 text-3xs text-red-600/80 dark:text-red-400/80"
                    numberOfLines={1}
                  >
                    {thread.session.lastError}
                  </Text>
                ) : thread.branch ? (
                  <Text
                    className="flex-1 text-3xs text-foreground-muted"
                    numberOfLines={1}
                    style={{ fontFamily: MONO_FONT }}
                  >
                    {thread.branch}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        </View>
      </Pressable>
    ) : (
      <Pressable
        accessibilityHint="Opens the thread. Swipe left to un-settle."
        accessibilityLabel={thread.title}
        accessibilityRole="button"
        className="bg-screen"
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        {/* Settled history recedes: dimmed favicon + muted title. */}
        <View className="min-h-[40px] flex-row items-center gap-2.5 px-5 py-2">
          {props.project ? (
            <View className="opacity-40">
              <ProjectFavicon
                environmentId={thread.environmentId}
                size={15}
                projectTitle={props.project.title}
                workspaceRoot={props.project.workspaceRoot}
              />
            </View>
          ) : null}
          <Text className="flex-1 text-base text-foreground-muted" numberOfLines={1}>
            {thread.title}
          </Text>
          <Text
            className="text-3xs tabular-nums text-foreground-tertiary"
            style={{ fontFamily: MONO_FONT }}
          >
            {relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)}
          </Text>
        </View>
      </Pressable>
    );

  return (
    <>
      {props.showSettledDivider ? <ThreadListV2SettledDivider /> : null}
      <ThreadSwipeable
        backgroundColor={screenColor}
        enableTrackpadSwipe
        fullSwipeWidth={windowWidth - 32}
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        resetKey={`${thread.environmentId}:${thread.id}`}
        simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <ControlPillMenu
            actions={variant === "card" ? CARD_MENU_ACTIONS : SLIM_MENU_ACTIONS}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </ControlPillMenu>
        )}
      </ThreadSwipeable>
      {props.showSettledDivider ? null : variant === "slim" ? (
        <View className="mx-5 h-px" style={{ backgroundColor: separatorColor, opacity: 0.5 }} />
      ) : null}
    </>
  );
});

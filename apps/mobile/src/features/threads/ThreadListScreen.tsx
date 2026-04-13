import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  useColorScheme,
  type View as RNView,
} from "react-native";
import Animated, { FadeInDown, LinearTransition } from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";

import { BrandMark } from "../../components/BrandMark";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { GlassSafeAreaView } from "../../components/GlassSafeAreaView";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import type { MobileLayout } from "../../lib/mobileLayout";
import {
  scopedThreadKey,
  type ScopedMobileProject,
  type ScopedMobileThread,
} from "../../lib/scopedEntities";
import type { RemoteClientConnectionState } from "../../lib/remoteClient";
import { relativeTime } from "../../lib/time";
import { groupProjectsByRepository, type MobileRepositoryGroup } from "../../lib/repositoryGroups";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { lastConversationLine, threadStatusTone } from "./threadPresentation";

export interface ThreadListScreenProps {
  readonly heroTitle: string;
  readonly showBrandWordmark: boolean;
  readonly screenTone: {
    readonly label: string;
    readonly pillClassName: string;
    readonly textClassName: string;
  };
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionPulse: boolean;
  readonly projects: ReadonlyArray<ScopedMobileProject>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly connectedEnvironmentCount: number;
  readonly hasClient: boolean;
  readonly hasServerConfig: boolean;
  readonly layout: MobileLayout;
  readonly hiddenThreadKey?: string | null;
  readonly selectedThreadKey?: string | null;
  readonly connectionError: string | null;
  readonly onOpenConnectionEditor: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly onCreateThread: (project: ScopedMobileProject) => Promise<void>;
  readonly onSelectThread: (
    thread: ScopedMobileThread,
    sourceFrame: TransitionSourceFrame | null,
  ) => void;
}

export interface TransitionSourceFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function ActionButton(props: {
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly primary?: boolean;
  readonly onPress: () => void;
}) {
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const secondaryForeground = useThemeColor("--color-secondary-foreground");
  const tintColor = props.primary ? primaryForeground : secondaryForeground;

  return (
    <Pressable
      className={cn(
        "min-h-[50px] flex-1 flex-row items-center justify-center gap-2 rounded-[16px] px-3 py-3",
        props.primary ? "bg-primary" : "border border-secondary-border bg-secondary",
      )}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColor={tintColor}
        type="monochrome"
        weight="medium"
      />
      <Text
        className={cn(
          "text-[13px] font-t3-bold uppercase",
          props.primary ? "text-primary-foreground" : "text-secondary-foreground",
        )}
        style={{ letterSpacing: 0.9 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function StatCard(props: {
  readonly label: string;
  readonly value: string;
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
}) {
  const foregroundSecondary = useThemeColor("--color-foreground-secondary");

  return (
    <View className="flex-1 gap-2 rounded-[18px] border border-border bg-card px-4 py-4">
      <View className="flex-row items-center gap-2">
        <SymbolView name={props.icon} size={15} tintColor={foregroundSecondary} type="monochrome" />
        <Text
          className="text-[11px] font-t3-bold uppercase text-foreground-secondary"
          style={{ letterSpacing: 1 }}
        >
          {props.label}
        </Text>
      </View>
      <Text className="text-[28px] font-t3-bold text-foreground">{props.value}</Text>
    </View>
  );
}

function ThreadRow(props: {
  readonly thread: ScopedMobileThread;
  readonly hidden?: boolean;
  readonly selected?: boolean;
  readonly onPress: (sourceFrame: TransitionSourceFrame | null) => void;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const cardColor = useThemeColor("--color-card");
  const borderColor = useThemeColor("--color-border");
  const containerRef = useRef<RNView>(null);
  const tone = threadStatusTone(props.thread);
  const backgroundColor = props.selected
    ? isDarkMode
      ? "rgba(249,115,22,0.12)"
      : "rgba(249,115,22,0.09)"
    : cardColor;
  const resolvedBorderColor = props.selected
    ? isDarkMode
      ? "rgba(249,115,22,0.32)"
      : "rgba(249,115,22,0.28)"
    : borderColor;

  return (
    <Pressable
      ref={containerRef}
      className="gap-3 rounded-[18px] border px-4 py-4"
      style={{
        backgroundColor,
        borderColor: resolvedBorderColor,
        opacity: props.hidden ? 0 : 1,
      }}
      onPress={() => {
        containerRef.current?.measureInWindow((x, y, width, height) => {
          if (width > 0 && height > 0) {
            props.onPress({ x, y, width, height });
            return;
          }
          props.onPress(null);
        });
      }}
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-2">
          <Text className="text-[17px] font-t3-bold text-foreground">{props.thread.title}</Text>
          <Text className="text-[13px] font-medium leading-[19px] text-foreground-secondary">
            {lastConversationLine(props.thread)}
          </Text>
        </View>
        <StatusPill {...tone} />
      </View>

      <Text
        className="text-[11px] font-t3-bold uppercase text-foreground-muted"
        style={{ letterSpacing: 0.9 }}
      >
        {props.thread.environmentLabel} · {props.thread.modelSelection.provider} ·{" "}
        {relativeTime(props.thread.updatedAt ?? props.thread.createdAt)}
      </Text>
    </Pressable>
  );
}

function ProjectSection(props: {
  readonly project: ScopedMobileProject;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly hiddenThreadKey?: string | null;
  readonly selectedThreadKey?: string | null;
  readonly onCreateThread: (project: ScopedMobileProject) => Promise<void>;
  readonly onSelectThread: (
    thread: ScopedMobileThread,
    sourceFrame: TransitionSourceFrame | null,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleThreads = expanded ? props.threads : props.threads.slice(0, 2);
  const hiddenCount = Math.max(props.threads.length - visibleThreads.length, 0);

  return (
    <View className="gap-3 rounded-[22px] border border-border px-4 py-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-[15px] font-t3-bold text-foreground">
            {props.project.environmentLabel}
          </Text>
          <Text className="text-[12px] font-medium leading-[18px] text-foreground-secondary">
            {props.project.workspaceRoot}
          </Text>
        </View>
        <Pressable
          className="rounded-full bg-subtle px-3 py-2"
          onPress={() => void props.onCreateThread(props.project)}
        >
          <Text
            className="text-[11px] font-t3-bold uppercase text-foreground"
            style={{ letterSpacing: 0.9 }}
          >
            New thread
          </Text>
        </Pressable>
      </View>

      {props.threads.length === 0 ? (
        <EmptyState
          title="No threads yet"
          detail="Start a thread in this environment to bring it onto the mobile board."
        />
      ) : (
        <View className="gap-3">
          {visibleThreads.map((thread) => (
            <ThreadRow
              key={scopedThreadKey(thread.environmentId, thread.id)}
              thread={thread}
              hidden={props.hiddenThreadKey === scopedThreadKey(thread.environmentId, thread.id)}
              selected={
                props.selectedThreadKey === scopedThreadKey(thread.environmentId, thread.id)
              }
              onPress={(sourceFrame) => props.onSelectThread(thread, sourceFrame)}
            />
          ))}

          {hiddenCount > 0 ? (
            <Pressable
              className="items-center rounded-[16px] bg-separator px-3 py-3"
              onPress={() => setExpanded((current) => !current)}
            >
              <Text
                className="text-[11px] font-t3-bold uppercase text-foreground-secondary"
                style={{ letterSpacing: 1 }}
              >
                {expanded ? "Show less" : `Show ${hiddenCount} more`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

function CreateThreadModal(props: {
  readonly group: MobileRepositoryGroup | null;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onSelectProject: (project: ScopedMobileProject) => Promise<void>;
}) {
  if (!props.group) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible={props.visible} onRequestClose={props.onClose}>
      <View className="flex-1 justify-end bg-backdrop">
        <View className="gap-4 rounded-t-[28px] bg-screen px-5 pb-8 pt-5">
          <View className="gap-1">
            <Text className="text-[22px] font-t3-bold text-foreground">
              New thread in {props.group.title}
            </Text>
            <Text className="text-[13px] font-medium leading-[19px] text-foreground-secondary">
              Choose which environment should own the new thread.
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
            {props.group.projects.map(({ project, threads }) => (
              <Pressable
                key={project.environmentId + project.id}
                className="gap-2 rounded-[20px] border border-border bg-card px-4 py-4"
                onPress={() => {
                  void props.onSelectProject(project).then(props.onClose);
                }}
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1 gap-1">
                    <Text className="text-[16px] font-t3-bold text-foreground">
                      {project.environmentLabel}
                    </Text>
                    <Text className="text-[12px] font-medium leading-[18px] text-foreground-secondary">
                      {project.workspaceRoot}
                    </Text>
                  </View>
                  <View className="rounded-full bg-subtle px-3 py-2">
                    <Text
                      className="text-[11px] font-t3-bold uppercase text-foreground"
                      style={{ letterSpacing: 0.9 }}
                    >
                      {threads.length} thread{threads.length === 1 ? "" : "s"}
                    </Text>
                  </View>
                </View>
              </Pressable>
            ))}
          </ScrollView>

          <ActionButton icon="xmark" label="Close" onPress={props.onClose} />
        </View>
      </View>
    </Modal>
  );
}

export function ThreadListScreen(props: ThreadListScreenProps) {
  const borderColorValue = useThemeColor("--color-border");
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: props.projects, threads: props.threads }),
    [props.projects, props.threads],
  );
  const [createTarget, setCreateTarget] = useState<MobileRepositoryGroup | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const isSplitLayout = props.layout.usesSplitView;
  const contentHorizontalPadding = isSplitLayout ? 18 : 20;
  const panelBorderColor = isSplitLayout ? borderColorValue : "transparent";
  const refreshThreads = props.onRefresh;

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) {
      return;
    }

    setRefreshing(true);
    try {
      await refreshThreads();
    } finally {
      setRefreshing(false);
    }
  }, [refreshThreads, refreshing]);

  return (
    <View
      className="flex-1 bg-screen"
      style={{
        borderRadius: isSplitLayout ? 32 : 0,
        borderWidth: isSplitLayout ? 1 : 0,
        borderColor: panelBorderColor,
        overflow: "hidden",
      }}
    >
      <View className="absolute inset-x-0 top-0 z-20">
        <GlassSafeAreaView leftSlot={props.showBrandWordmark ? <BrandMark compact /> : null} />
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} />
        }
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: contentHorizontalPadding,
          paddingBottom: isSplitLayout ? 32 : 48,
          paddingTop: isSplitLayout ? 112 : 124,
        }}
      >
        <Animated.View
          entering={FadeInDown.duration(260)}
          layout={LinearTransition.springify().damping(18).stiffness(180)}
          className="gap-4 rounded-[26px] border border-border bg-card-translucent px-4 py-4"
        >
          <View className="flex-row items-start justify-between gap-4">
            <View className="flex-1 gap-2">
              <Text
                className="text-[11px] font-t3-bold uppercase text-foreground-muted"
                style={{ letterSpacing: 1.1 }}
              >
                {props.heroTitle}
              </Text>
              <Text className="text-[26px] font-t3-bold text-foreground">
                {isSplitLayout ? "Native workspace" : "Repo board"}
              </Text>
              <Text className="text-[13px] font-medium leading-[19px] text-foreground-secondary">
                {isSplitLayout
                  ? "Keep your repositories visible while you move between active threads."
                  : "Your connected repositories, grouped by identity across environments."}
              </Text>
            </View>
            <ConnectionStatusDot state={props.connectionState} pulse={props.connectionPulse} />
          </View>

          <View className="flex-row gap-3">
            <StatCard label="Repos" value={String(repositoryGroups.length)} icon="shippingbox" />
            <StatCard
              label="Threads"
              value={String(props.threads.length)}
              icon="square.stack.3d.up"
            />
            <StatCard label="Envs" value={String(props.connectedEnvironmentCount)} icon="link" />
          </View>

          <View className="flex-row gap-3">
            <ActionButton
              icon={props.hasClient ? "link" : "iphone"}
              label={props.hasClient ? "Edit link" : "Connect"}
              primary
              onPress={props.onOpenConnectionEditor}
            />
            <ActionButton
              icon="arrow.clockwise"
              label="Refresh"
              onPress={() => void handleRefresh()}
            />
          </View>
        </Animated.View>

        {repositoryGroups.length === 0 ? (
          <EmptyState
            title={props.hasClient ? "No repositories yet" : "No connection yet"}
            detail={
              props.hasClient
                ? "Connect an environment with indexed projects, then refresh this screen."
                : "Connect this phone to a T3 environment to load repositories and threads."
            }
          />
        ) : null}

        {repositoryGroups.map((group, index) => (
          <Animated.View
            key={group.key}
            entering={FadeInDown.duration(260).delay(40 * Math.min(index, 6))}
            layout={LinearTransition.springify().damping(18).stiffness(180)}
            className="gap-4 rounded-[26px] border border-border bg-card-translucent px-4 py-4"
          >
            <View className="flex-row items-start justify-between gap-4">
              <View className="flex-1 gap-1">
                <Text className="text-[22px] font-t3-bold text-foreground">{group.title}</Text>
                {group.subtitle ? (
                  <Text className="text-[13px] font-medium leading-[19px] text-foreground-secondary">
                    {group.subtitle}
                  </Text>
                ) : null}
                <Text
                  className="text-[11px] font-t3-bold uppercase text-foreground-muted"
                  style={{ letterSpacing: 0.9 }}
                >
                  {group.projectCount} environment{group.projectCount === 1 ? "" : "s"} ·{" "}
                  {group.threadCount} active thread{group.threadCount === 1 ? "" : "s"}
                </Text>
              </View>

              <Pressable
                className="rounded-full bg-primary px-3 py-2"
                onPress={() => {
                  if (group.projects.length === 1) {
                    void props.onCreateThread(group.projects[0]!.project);
                    return;
                  }
                  setCreateTarget(group);
                }}
              >
                <Text
                  className="text-[11px] font-t3-bold uppercase text-primary-foreground"
                  style={{ letterSpacing: 0.9 }}
                >
                  New thread
                </Text>
              </Pressable>
            </View>

            <View className="gap-3">
              {group.projects.map(({ project, threads }) => (
                <ProjectSection
                  key={project.environmentId + project.id}
                  project={project}
                  threads={threads}
                  hiddenThreadKey={props.hiddenThreadKey}
                  selectedThreadKey={props.selectedThreadKey}
                  onCreateThread={props.onCreateThread}
                  onSelectThread={props.onSelectThread}
                />
              ))}
            </View>
          </Animated.View>
        ))}
      </ScrollView>

      <CreateThreadModal
        group={createTarget}
        visible={createTarget !== null}
        onClose={() => setCreateTarget(null)}
        onSelectProject={props.onCreateThread}
      />
    </View>
  );
}

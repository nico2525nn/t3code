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

import { BrandMark } from "../../components/BrandMark";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { GlassSafeAreaView } from "../../components/GlassSafeAreaView";
import { StatusPill } from "../../components/StatusPill";
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
  return (
    <Pressable
      className="min-h-[50px] flex-1 flex-row items-center justify-center gap-2 rounded-[16px] px-3 py-3"
      style={{
        backgroundColor: props.primary ? "#171717" : "#ffffff",
        borderWidth: props.primary ? 0 : 1,
        borderColor: props.primary ? "transparent" : "rgba(23,23,23,0.08)",
      }}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColor={props.primary ? "#fafaf9" : "#171717"}
        type="monochrome"
        weight="medium"
      />
      <Text
        className="text-[13px] font-t3-bold uppercase"
        style={{
          color: props.primary ? "#fafaf9" : "#171717",
          letterSpacing: 0.9,
        }}
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
  return (
    <View
      className="flex-1 gap-2 rounded-[18px] px-4 py-4"
      style={{
        backgroundColor: "#ffffff",
        borderWidth: 1,
        borderColor: "rgba(23,23,23,0.08)",
      }}
    >
      <View className="flex-row items-center gap-2">
        <SymbolView name={props.icon} size={15} tintColor="#57534e" type="monochrome" />
        <Text
          className="text-[11px] font-t3-bold uppercase"
          style={{ color: "#57534e", letterSpacing: 1 }}
        >
          {props.label}
        </Text>
      </View>
      <Text className="text-[28px] font-t3-bold" style={{ color: "#171717" }}>
        {props.value}
      </Text>
    </View>
  );
}

function ThreadRow(props: {
  readonly thread: ScopedMobileThread;
  readonly hidden?: boolean;
  readonly selected?: boolean;
  readonly onPress: (sourceFrame: TransitionSourceFrame | null) => void;
}) {
  const containerRef = useRef<RNView>(null);
  const tone = threadStatusTone(props.thread);
  const backgroundColor = props.selected ? "rgba(249,115,22,0.09)" : "#ffffff";
  const borderColor = props.selected ? "rgba(249,115,22,0.28)" : "rgba(23,23,23,0.08)";

  return (
    <Pressable
      ref={containerRef}
      className="gap-3 rounded-[18px] border px-4 py-4"
      style={{
        backgroundColor,
        borderColor,
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
          <Text className="text-[17px] font-t3-bold" style={{ color: "#171717" }}>
            {props.thread.title}
          </Text>
          <Text className="text-[13px] font-medium leading-[19px]" style={{ color: "#57534e" }}>
            {lastConversationLine(props.thread)}
          </Text>
        </View>
        <StatusPill {...tone} />
      </View>

      <Text
        className="text-[11px] font-t3-bold uppercase"
        style={{ color: "#78716c", letterSpacing: 0.9 }}
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
    <View
      className="gap-3 rounded-[22px] border px-4 py-4"
      style={{ borderColor: "rgba(23,23,23,0.08)" }}
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-[15px] font-t3-bold" style={{ color: "#171717" }}>
            {props.project.environmentLabel}
          </Text>
          <Text className="text-[12px] font-medium leading-[18px]" style={{ color: "#57534e" }}>
            {props.project.workspaceRoot}
          </Text>
        </View>
        <Pressable
          className="rounded-full px-3 py-2"
          style={{ backgroundColor: "rgba(23,23,23,0.06)" }}
          onPress={() => void props.onCreateThread(props.project)}
        >
          <Text
            className="text-[11px] font-t3-bold uppercase"
            style={{ color: "#171717", letterSpacing: 0.9 }}
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
              className="items-center rounded-[16px] px-3 py-3"
              style={{ backgroundColor: "rgba(23,23,23,0.04)" }}
              onPress={() => setExpanded((current) => !current)}
            >
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: "#57534e", letterSpacing: 1 }}
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
      <View className="flex-1 justify-end" style={{ backgroundColor: "rgba(10,10,10,0.24)" }}>
        <View className="gap-4 rounded-t-[28px] bg-stone-50 px-5 pb-8 pt-5">
          <View className="gap-1">
            <Text className="text-[22px] font-t3-bold" style={{ color: "#171717" }}>
              New thread in {props.group.title}
            </Text>
            <Text className="text-[13px] font-medium leading-[19px]" style={{ color: "#57534e" }}>
              Choose which environment should own the new thread.
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
            {props.group.projects.map(({ project, threads }) => (
              <Pressable
                key={project.environmentId + project.id}
                className="gap-2 rounded-[20px] border bg-white px-4 py-4"
                style={{ borderColor: "rgba(23,23,23,0.08)" }}
                onPress={() => {
                  void props.onSelectProject(project).then(props.onClose);
                }}
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1 gap-1">
                    <Text className="text-[16px] font-t3-bold" style={{ color: "#171717" }}>
                      {project.environmentLabel}
                    </Text>
                    <Text
                      className="text-[12px] font-medium leading-[18px]"
                      style={{ color: "#57534e" }}
                    >
                      {project.workspaceRoot}
                    </Text>
                  </View>
                  <View
                    className="rounded-full px-3 py-2"
                    style={{ backgroundColor: "rgba(23,23,23,0.06)" }}
                  >
                    <Text
                      className="text-[11px] font-t3-bold uppercase"
                      style={{ color: "#171717", letterSpacing: 0.9 }}
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
  const isDarkMode = useColorScheme() === "dark";
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: props.projects, threads: props.threads }),
    [props.projects, props.threads],
  );
  const [createTarget, setCreateTarget] = useState<MobileRepositoryGroup | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const isSplitLayout = props.layout.usesSplitView;
  const contentHorizontalPadding = isSplitLayout ? 18 : 20;
  const panelBorderColor = isSplitLayout ? "rgba(23,23,23,0.08)" : "transparent";
  const panelBackgroundColor = isDarkMode ? "#0c1118" : "#f7f7f5";
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
      className="flex-1"
      style={{
        backgroundColor: panelBackgroundColor,
        borderRadius: isSplitLayout ? 32 : 0,
        borderWidth: isSplitLayout ? 1 : 0,
        borderColor: panelBorderColor,
        overflow: "hidden",
      }}
    >
      <View className="absolute inset-x-0 top-0 z-20">
        <GlassSafeAreaView
          leftSlot={props.showBrandWordmark ? <BrandMark compact dark={isDarkMode} /> : null}
        />
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
          className="gap-4 rounded-[26px] px-4 py-4"
          style={{
            backgroundColor: "rgba(255,255,255,0.94)",
            borderWidth: 1,
            borderColor: "rgba(23,23,23,0.08)",
          }}
        >
          <View className="flex-row items-start justify-between gap-4">
            <View className="flex-1 gap-2">
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: "#78716c", letterSpacing: 1.1 }}
              >
                {props.heroTitle}
              </Text>
              <Text className="text-[26px] font-t3-bold" style={{ color: "#171717" }}>
                {isSplitLayout ? "Native workspace" : "Repo board"}
              </Text>
              <Text className="text-[13px] font-medium leading-[19px]" style={{ color: "#57534e" }}>
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
            className="gap-4 rounded-[26px] px-4 py-4"
            style={{
              backgroundColor: "rgba(255,255,255,0.94)",
              borderWidth: 1,
              borderColor: "rgba(23,23,23,0.08)",
            }}
          >
            <View className="flex-row items-start justify-between gap-4">
              <View className="flex-1 gap-1">
                <Text className="text-[22px] font-t3-bold" style={{ color: "#171717" }}>
                  {group.title}
                </Text>
                {group.subtitle ? (
                  <Text
                    className="text-[13px] font-medium leading-[19px]"
                    style={{ color: "#57534e" }}
                  >
                    {group.subtitle}
                  </Text>
                ) : null}
                <Text
                  className="text-[11px] font-t3-bold uppercase"
                  style={{ color: "#78716c", letterSpacing: 0.9 }}
                >
                  {group.projectCount} environment{group.projectCount === 1 ? "" : "s"} ·{" "}
                  {group.threadCount} active thread{group.threadCount === 1 ? "" : "s"}
                </Text>
              </View>

              <Pressable
                className="rounded-full px-3 py-2"
                style={{ backgroundColor: "#171717" }}
                onPress={() => {
                  if (group.projects.length === 1) {
                    void props.onCreateThread(group.projects[0]!.project);
                    return;
                  }
                  setCreateTarget(group);
                }}
              >
                <Text
                  className="text-[11px] font-t3-bold uppercase"
                  style={{ color: "#fafaf9", letterSpacing: 0.9 }}
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

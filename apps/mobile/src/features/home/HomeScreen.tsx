import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill } from "../../components/StatusPill";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import type { ScopedMobileProject, ScopedMobileThread } from "../../lib/scopedEntities";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { threadStatusTone } from "../threads/threadPresentation";

export function HomeScreen(props: {
  readonly projects: ReadonlyArray<ScopedMobileProject>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly connectionState: "ready" | "connecting" | "reconnecting" | "disconnected" | "idle";
  readonly connectionPulse: boolean;
  readonly onOpenConnectionEditor: () => void;
  readonly onOpenNewTask: () => void;
  readonly onSelectThread: (thread: ScopedMobileThread) => void;
}) {
  const insets = useSafeAreaInsets();
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: props.projects, threads: props.threads }),
    [props.projects, props.threads],
  );
  const projectLabelsByKey = useMemo(() => {
    const map = new Map<
      string,
      {
        readonly projectTitle: string;
        readonly environmentLabel: string;
      }
    >();

    for (const group of repositoryGroups) {
      const primaryProjectTitle = group.projects[0]?.project.title ?? group.title;
      for (const projectGroup of group.projects) {
        map.set(scopedProjectKey(projectGroup.project.environmentId, projectGroup.project.id), {
          projectTitle: primaryProjectTitle,
          environmentLabel: projectGroup.project.environmentLabel,
        });
      }
    }

    return map;
  }, [repositoryGroups]);

  return (
    <View style={{ flex: 1, backgroundColor: "#f6f4ef" }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 24) + 92,
          paddingHorizontal: 20,
          paddingTop: insets.top + 6,
          gap: 16,
        }}
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-[34px] font-t3-bold" style={{ color: "#171717" }}>
            Recents
          </Text>

          <Pressable
            onPress={props.onOpenConnectionEditor}
            className="h-14 min-w-[56px] items-center justify-center rounded-full px-4"
            style={{ backgroundColor: "rgba(255,255,255,0.9)" }}
          >
            <ConnectionStatusDot state={props.connectionState} pulse={props.connectionPulse} />
          </Pressable>
        </View>

        {props.threads.length === 0 ? (
          <EmptyState
            title="No threads yet"
            detail="Create a task to start a new coding session in one of your connected projects."
          />
        ) : (
          <View className="overflow-hidden rounded-[24px]" style={{ backgroundColor: "#ffffff" }}>
            {props.threads.map((thread, index) => {
              const projectKey = scopedProjectKey(thread.environmentId, thread.projectId);
              const projectLabel = projectLabelsByKey.get(projectKey);

              return (
                <Pressable
                  key={`${thread.environmentId}:${thread.id}`}
                  onPress={() => props.onSelectThread(thread)}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 13,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: "rgba(23,23,23,0.06)",
                  }}
                >
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1 gap-1.5">
                      <Text
                        className="text-[17px] font-t3-bold leading-[24px]"
                        numberOfLines={2}
                        style={{ color: "#171717" }}
                      >
                        {thread.title}
                      </Text>
                    </View>
                    <StatusPill {...threadStatusTone(thread)} size="compact" />
                  </View>

                  <View className="mt-2 flex-row items-center justify-between gap-3">
                    <View className="flex-1 flex-row items-center gap-2">
                      <Text
                        className="text-[13px] font-medium leading-[18px]"
                        numberOfLines={1}
                        style={{ color: "#57534e", flexShrink: 1 }}
                      >
                        {projectLabel?.projectTitle ?? thread.title}
                      </Text>
                      <View
                        className="h-1 w-1 rounded-full"
                        style={{ backgroundColor: "rgba(120,113,108,0.45)" }}
                      />
                      <Text
                        className="text-[12px] font-t3-bold uppercase tracking-[0.4px]"
                        numberOfLines={1}
                        style={{ color: "#78716c", flexShrink: 1 }}
                      >
                        {projectLabel?.environmentLabel ?? "Local"}
                      </Text>
                    </View>
                    <Text
                      className="text-[12px] font-t3-bold"
                      style={{ color: "#78716c", fontVariant: ["tabular-nums"] }}
                    >
                      {relativeTime(thread.updatedAt ?? thread.createdAt)}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          right: 20,
          bottom: Math.max(insets.bottom, 18),
        }}
      >
        <Pressable
          onPress={props.onOpenNewTask}
          className="flex-row items-center gap-3 rounded-full px-6 py-4"
          style={{
            backgroundColor: "#171717",
            boxShadow: "0 20px 36px rgba(23,23,23,0.18)",
          }}
        >
          <SymbolView name="square.and.pencil" size={20} tintColor="#fafaf9" type="monochrome" />
          <Text className="text-[18px] font-t3-bold" style={{ color: "#fafaf9" }}>
            New task
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

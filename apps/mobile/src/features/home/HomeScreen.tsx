import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { Pressable, ScrollView, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill } from "../../components/StatusPill";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import type { ScopedMobileProject, ScopedMobileThread } from "../../lib/scopedEntities";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { makeAppPalette } from "../../lib/theme";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { threadStatusTone } from "../threads/threadPresentation";

function T3Wordmark(props: { readonly fill: string }) {
  return (
    <Svg
      viewBox="15.5309 37 94.3941 56.96"
      style={{ height: 16, width: 24 }}
    >
      <Path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill={props.fill}
      />
    </Svg>
  );
}

export function HomeScreen(props: {
  readonly projects: ReadonlyArray<ScopedMobileProject>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly connectionState: "ready" | "connecting" | "reconnecting" | "disconnected" | "idle";
  readonly connectionPulse: boolean;
  readonly onOpenConnectionEditor: () => void;
  readonly onOpenNewTask: () => void;
  readonly onSelectThread: (thread: ScopedMobileThread) => void;
  readonly showFloatingConnectionButton: boolean;
  readonly showFloatingNewTaskButton: boolean;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
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
    <View style={{ flex: 1, backgroundColor: palette.screenBackground }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 24) + (props.showFloatingNewTaskButton ? 92 : 24),
          paddingHorizontal: 20,
          paddingTop: insets.top + 16,
          gap: 20,
        }}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <T3Wordmark fill={palette.wordmarkFill} />
            <Text
              className="text-[18px] font-medium"
              style={{ color: palette.text }}
            >
              Code
            </Text>
            <View
              className="rounded-[6px] px-2 py-0.5"
              style={{ backgroundColor: palette.subtleBg }}
            >
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: palette.textMuted, letterSpacing: 0.8 }}
              >
                Alpha
              </Text>
            </View>
          </View>

          {props.showFloatingConnectionButton ? (
            <Pressable
              onPress={props.onOpenConnectionEditor}
              className="h-10 w-10 items-center justify-center rounded-full"
              style={{ backgroundColor: palette.subtleBg }}
            >
              <ConnectionStatusDot state={props.connectionState} pulse={props.connectionPulse} />
            </Pressable>
          ) : null}
        </View>

        <Text
          className="text-[28px] font-t3-bold"
          style={{ color: palette.text, letterSpacing: -0.3 }}
        >
          Recents
        </Text>

        {props.threads.length === 0 ? (
          <EmptyState
            title="No threads yet"
            detail="Create a task to start a new coding session in one of your connected projects."
          />
        ) : (
          <View className="overflow-hidden rounded-[24px]" style={{ backgroundColor: palette.card }}>
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
                    borderTopColor: palette.borderSubtle,
                  }}
                >
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1 gap-1.5">
                      <Text
                        className="text-[17px] font-t3-bold leading-[24px]"
                        numberOfLines={2}
                        style={{ color: palette.text }}
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
                        style={{ color: palette.textSecondary, flexShrink: 1 }}
                      >
                        {projectLabel?.projectTitle ?? thread.title}
                      </Text>
                      <View
                        className="h-1 w-1 rounded-full"
                        style={{ backgroundColor: palette.dotSeparator }}
                      />
                      <Text
                        className="text-[12px] font-t3-bold uppercase tracking-[0.4px]"
                        numberOfLines={1}
                        style={{ color: palette.textMuted, flexShrink: 1 }}
                      >
                        {projectLabel?.environmentLabel ?? "Local"}
                      </Text>
                    </View>
                    <Text
                      className="text-[12px] font-t3-bold"
                      style={{ color: palette.textMuted, fontVariant: ["tabular-nums"] }}
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

      {props.showFloatingNewTaskButton ? (
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
              backgroundColor: palette.primaryButton,
              boxShadow: `0 20px 36px ${palette.primaryButtonShadow}`,
            }}
          >
            <SymbolView name="square.and.pencil" size={20} tintColor={palette.primaryButtonText} type="monochrome" />
            <Text className="text-[18px] font-t3-bold" style={{ color: palette.primaryButtonText }}>
              New task
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

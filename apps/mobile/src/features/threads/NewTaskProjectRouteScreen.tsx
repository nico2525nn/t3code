import { useFocusEffect, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { FlatList, Pressable, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import { buildNewTaskDraftRoutePath } from "../../lib/routes";
import type { ScopedMobileProject } from "../../lib/scopedEntities";
import { makeAppPalette } from "../../lib/theme";
import { useRemoteApp } from "../../state/remote-app-state-provider";
import { useNewTaskFlow } from "./new-task-flow-provider";

const DEV_FAKE_PROJECT_COUNT = 15;

type PickerEntry = {
  readonly key: string;
  readonly project: ScopedMobileProject;
};

export function NewTaskProjectRouteScreen() {
  const app = useRemoteApp();
  const router = useRouter();
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const insets = useSafeAreaInsets();
  const { reset } = useNewTaskFlow();
  const listRef = useRef<FlatList<PickerEntry> | null>(null);
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: app.projects, threads: app.threads }),
    [app.projects, app.threads],
  );
  const logicalProjects = useMemo(
    () =>
      repositoryGroups
        .map((group) => {
          const primaryProject = group.projects[0]?.project;
          if (!primaryProject) {
            return null;
          }
          return { key: group.key, project: primaryProject };
        })
        .filter((entry) => entry !== null),
    [repositoryGroups],
  );
  const pickerEntries = useMemo(() => {
    if (!__DEV__ || logicalProjects.length === 0) {
      return logicalProjects;
    }

    const fakeEntries = Array.from({ length: DEV_FAKE_PROJECT_COUNT }, (_, index) => {
      const source = logicalProjects[index % logicalProjects.length]!;

      return {
        key: `dev-preview-${index + 1}`,
        project: {
          ...source.project,
          title: `${source.project.title} preview ${index + 1}`,
        },
      };
    });

    return [...logicalProjects, ...fakeEntries];
  }, [logicalProjects]);

  useEffect(() => {
    console.log("[new task project screen] render", {
      logicalProjects: pickerEntries.map((entry) => ({
        key: entry.key,
        title: entry.project.title,
      })),
      pathnameTarget: "/new",
      projectCount: app.projects.length,
      threadCount: app.threads.length,
    });
  }, [app.projects.length, app.threads.length, pickerEntries]);

  useEffect(() => {
    console.log("[new task project screen] reset flow");
    reset();
  }, [reset]);

  useFocusEffect(
    useCallback(() => {
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ animated: false, offset: 0 });
      });
    }, []),
  );

  useEffect(() => {
    if (logicalProjects.length !== 1) {
      console.log("[new task project screen] staying on picker", {
        logicalProjectCount: logicalProjects.length,
      });
      return;
    }

    console.log("[new task project screen] auto-forward to draft", {
      environmentId: logicalProjects[0]!.project.environmentId,
      projectId: logicalProjects[0]!.project.id,
      title: logicalProjects[0]!.project.title,
    });
    router.replace(buildNewTaskDraftRoutePath(logicalProjects[0]!.project));
  }, [logicalProjects, router]);

  if (app.projects.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.sheetBackground }}>
        <View
          style={{
            flex: 1,
            paddingTop: 28,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
        >
          <View className="items-center gap-1 px-5 pb-4">
            <Text
              className="text-[12px] font-t3-bold uppercase"
              style={{ color: palette.textMuted, letterSpacing: 1 }}
            >
              New task
            </Text>
            <Text className="text-[28px] font-t3-bold" style={{ color: palette.text }}>
              Choose project
            </Text>
          </View>

          <View
            className="mx-5 items-center rounded-[24px] px-6 py-8"
            style={{ backgroundColor: palette.card }}
          >
            <Text className="text-[16px] font-medium" style={{ color: palette.textMuted }}>
              Loading projects…
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.sheetBackground }}>
      <View
        style={{
          flex: 1,
          paddingTop: 28,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <View style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            data={pickerEntries}
            keyExtractor={(entry) => entry.key}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: 28,
              paddingBottom: Math.max(insets.bottom, 18) + 18,
            }}
            ListHeaderComponent={
              <View className="items-center gap-1 pb-4">
                <Text
                  className="text-[12px] font-t3-bold uppercase"
                  style={{ color: palette.textMuted, letterSpacing: 1 }}
                >
                  New task
                </Text>
                <Text className="text-[28px] font-t3-bold" style={{ color: palette.text }}>
                  Choose project
                </Text>
              </View>
            }
            renderItem={({ item, index }) => {
              const isFirst = index === 0;
              const isLast = index === pickerEntries.length - 1;

              return (
                <Pressable
                  onPress={() => router.push(buildNewTaskDraftRoutePath(item.project))}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 18,
                    borderTopWidth: isFirst ? 0 : 1,
                    borderTopColor: palette.borderSubtle,
                    backgroundColor: palette.card,
                    borderTopLeftRadius: isFirst ? 24 : 0,
                    borderTopRightRadius: isFirst ? 24 : 0,
                    borderBottomLeftRadius: isLast ? 24 : 0,
                    borderBottomRightRadius: isLast ? 24 : 0,
                  }}
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-[18px] font-t3-bold" style={{ color: palette.text }}>
                        {item.project.title}
                      </Text>
                    </View>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColor={palette.chevronColor}
                      type="monochrome"
                    />
                  </View>
                </Pressable>
              );
            }}
          />
        </View>
      </View>
    </View>
  );
}

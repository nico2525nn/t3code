import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { Pressable, ScrollView, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import { makeAppPalette } from "../../lib/theme";
import { useRemoteApp } from "../../state/remote-app-state-provider";

export default function NewTaskRoute() {
  const app = useRemoteApp();
  const router = useRouter();
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const insets = useSafeAreaInsets();
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: app.projects, threads: app.threads }),
    [app.projects, app.threads],
  );
  const items = useMemo(
    () =>
      repositoryGroups
        .map((group) => {
          const project = group.projects[0]?.project;
          if (!project) {
            return null;
          }

          return {
            environmentId: project.environmentId,
            id: project.id,
            key: group.key,
            title: project.title,
          };
        })
        .filter((entry) => entry !== null),
    [repositoryGroups],
  );

  return (
    <View
      collapsable={false}
      style={{
        flex: 1,
        backgroundColor: palette.sheetBackground,
        paddingHorizontal: 20,
        paddingTop: 28,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
      }}
    >
      <View collapsable={false} className="items-center gap-1 pb-4">
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

      <ScrollView
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 8 }}
      >
        {items.length === 0 ? (
          <View
            collapsable={false}
            className="items-center rounded-[24px] px-6 py-8"
            style={{ backgroundColor: palette.card }}
          >
            <Text className="text-[16px] font-medium" style={{ color: palette.textMuted }}>
              Loading projects…
            </Text>
          </View>
        ) : (
          <View
            collapsable={false}
            className="overflow-hidden rounded-[24px]"
            style={{ backgroundColor: palette.card }}
          >
            {items.map((item, index) => {
              const isFirst = index === 0;
              const isLast = index === items.length - 1;

              return (
                <Pressable
                  key={item.key}
                  onPress={() =>
                    router.push({
                      pathname: "/new/draft",
                      params: {
                        environmentId: item.environmentId,
                        projectId: item.id,
                        title: item.title,
                      },
                    })
                  }
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
                        {item.title}
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
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

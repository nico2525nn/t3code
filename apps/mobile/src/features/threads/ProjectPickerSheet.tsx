import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import { makeAppPalette } from "../../lib/theme";
import type { ScopedMobileProject, ScopedMobileThread } from "../../lib/scopedEntities";

export function ProjectPickerSheet(props: {
  readonly visible: boolean;
  readonly projects: ReadonlyArray<ScopedMobileProject>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly onClose: () => void;
  readonly onSelectProject: (project: ScopedMobileProject) => void;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: props.projects, threads: props.threads }),
    [props.projects, props.threads],
  );
  const logicalProjects = useMemo(
    () =>
      repositoryGroups
        .map((group) => {
          const primaryProject = group.projects[0]?.project;
          if (!primaryProject) {
            return null;
          }

          return {
            key: group.key,
            project: primaryProject,
          };
        })
        .filter((entry) => entry !== null),
    [repositoryGroups],
  );
  const renderBackdrop = useCallback(
    (backdropProps: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.18}
        pressBehavior="close"
      />
    ),
    [],
  );

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) {
      return;
    }

    if (props.visible) {
      sheet.present();
      return;
    }

    sheet.dismiss();
  }, [props.visible]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={["88%"]}
      enableDynamicSizing={false}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={props.onClose}
      backgroundStyle={{ backgroundColor: palette.sheetBackground }}
      handleIndicatorStyle={{ backgroundColor: palette.dotSeparator }}
    >
      <BottomSheetView className="px-4 pt-1">
        <View className="mb-4 items-center gap-1">
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

        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
        >
          <View className="overflow-hidden rounded-[24px]" style={{ backgroundColor: palette.card }}>
            {logicalProjects.map((entry, index) => (
              <Pressable
                key={entry.key}
                onPress={() => props.onSelectProject(entry.project)}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 18,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: palette.borderSubtle,
                }}
              >
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-[18px] font-t3-bold" style={{ color: palette.text }}>
                      {entry.project.title}
                    </Text>
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        </BottomSheetScrollView>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

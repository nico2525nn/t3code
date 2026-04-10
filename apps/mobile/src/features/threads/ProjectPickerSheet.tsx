import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import type { ScopedMobileProject, ScopedMobileThread } from "../../lib/scopedEntities";

export function ProjectPickerSheet(props: {
  readonly visible: boolean;
  readonly projects: ReadonlyArray<ScopedMobileProject>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly onClose: () => void;
  readonly onSelectProject: (project: ScopedMobileProject) => void;
}) {
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
      backgroundStyle={{ backgroundColor: "rgba(250,248,242,0.98)" }}
      handleIndicatorStyle={{ backgroundColor: "rgba(120,113,108,0.35)" }}
    >
      <BottomSheetView className="px-4 pt-1">
        <View className="mb-4 items-center gap-1">
          <Text
            className="text-[12px] font-t3-bold uppercase"
            style={{ color: "#78716c", letterSpacing: 1 }}
          >
            New task
          </Text>
          <Text className="text-[28px] font-t3-bold" style={{ color: "#171717" }}>
            Choose project
          </Text>
        </View>

        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
        >
          <View className="overflow-hidden rounded-[24px]" style={{ backgroundColor: "#ffffff" }}>
            {logicalProjects.map((entry, index) => (
              <Pressable
                key={entry.key}
                onPress={() => props.onSelectProject(entry.project)}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 18,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: "rgba(23,23,23,0.06)",
                }}
              >
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-[18px] font-t3-bold" style={{ color: "#171717" }}>
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

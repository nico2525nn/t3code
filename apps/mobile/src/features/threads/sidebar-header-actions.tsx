import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, View, useColorScheme } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
  readonly onStartNewTask?: () => void;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "gearshape" | "square.and.pencil";
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const idleBackgroundColor =
    colorScheme === "dark" ? "rgba(118,118,128,0.24)" : "rgba(255,255,255,0.72)";
  const borderColor = colorScheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: pressed ? pressedBackgroundColor : idleBackgroundColor,
          borderColor,
        },
      ]}
    >
      <SymbolView name={props.icon} size={18} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View style={styles.actions}>
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
      {props.onStartNewTask ? (
        <FallbackHeaderButton
          accessibilityLabel="New task"
          icon="square.and.pencil"
          onPress={props.onStartNewTask}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
});

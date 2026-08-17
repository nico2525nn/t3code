import { SymbolView } from "../../components/AppSymbol";
import { Pressable, View } from "react-native";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
  /** Rendered inside a shared capsule group — buttons drop their own chrome. */
  readonly grouped?: boolean;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "gearshape" | "square.and.pencil";
  readonly grouped?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      className={
        props.grouped
          ? "h-11 w-[50px] items-center justify-center rounded-[22px] bg-transparent active:bg-subtle"
          : "h-11 w-[50px] items-center justify-center rounded-[22px] border border-header-border bg-glass-surface active:bg-subtle"
      }
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="flex-row items-center gap-0.5">
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        grouped={props.grouped}
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}

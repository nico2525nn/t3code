import { SymbolView } from "../../components/AppSymbol";
import { Pressable } from "react-native";

export type SidebarFilterButtonIcon =
  | "line.3.horizontal.decrease.circle"
  | "line.3.horizontal.decrease.circle.fill";

export function SidebarFilterButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: SidebarFilterButtonIcon;
  /** Rendered inside a shared capsule group — no own background/border. */
  readonly grouped?: boolean;
}) {
  return (
    <Pressable
      className={
        props.grouped
          ? "h-11 w-[50px] cursor-pointer items-center justify-center rounded-[22px] bg-transparent active:bg-subtle"
          : "h-11 w-[50px] cursor-pointer items-center justify-center rounded-[22px] border border-header-border bg-glass-surface active:bg-subtle"
      }
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
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

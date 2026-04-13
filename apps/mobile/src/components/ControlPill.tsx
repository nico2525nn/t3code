import type { ComponentProps, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useThemeColor } from "../lib/useThemeColor";

import { AppText as Text } from "./AppText";

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
}) {
  const variant = props.variant ?? "circle";

  const subtleBg = useThemeColor("--color-subtle");
  const subtleBgStrong = useThemeColor("--color-subtle-strong");
  const primaryBg = useThemeColor("--color-primary");
  const dangerBg = useThemeColor("--color-danger");
  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const textColor = useThemeColor("--color-foreground");
  const textMuted = useThemeColor("--color-foreground-muted");

  const backgroundColor =
    variant === "primary"
      ? props.disabled
        ? subtleBgStrong
        : primaryBg
      : variant === "danger"
        ? dangerBg
        : subtleBg;
  const iconTintColor =
    variant === "primary"
      ? props.disabled
        ? iconSubtle
        : primaryFg
      : variant === "danger"
        ? dangerFg
        : iconColor;
  const labelColor = variant === "primary" ? (props.disabled ? textMuted : primaryFg) : textColor;

  const isCircle =
    variant === "circle" || variant === "danger" || (variant === "primary" && !props.label);

  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      className={
        isCircle
          ? "h-11 w-11 items-center justify-center rounded-full"
          : variant === "primary"
            ? "h-11 flex-row items-center justify-center gap-2 rounded-full px-5"
            : "h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5"
      }
      style={{ backgroundColor }}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
      ) : null}
      {props.label ? (
        <Text className="text-center text-[12px] font-t3-bold" style={{ color: labelColor }}>
          {props.label}
        </Text>
      ) : null}
    </Pressable>
  );
}

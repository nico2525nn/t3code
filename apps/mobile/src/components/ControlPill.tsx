import type { ComponentProps, ReactNode } from "react";
import { Pressable, useColorScheme, View } from "react-native";
import { SymbolView } from "expo-symbols";

import { AppText as Text } from "./AppText";
import { makeAppPalette } from "../lib/theme";

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const variant = props.variant ?? "circle";
  const backgroundColor =
    variant === "primary"
      ? props.disabled
        ? palette.subtleBgStrong
        : palette.primaryButton
      : variant === "danger"
        ? palette.dangerButton
        : palette.subtleBg;
  const iconTintColor =
    variant === "primary"
      ? props.disabled
        ? palette.iconSubtle
        : palette.primaryButtonText
      : variant === "danger"
        ? palette.dangerText
        : palette.icon;
  const textColor =
    variant === "primary"
      ? props.disabled
        ? palette.textMuted
        : palette.primaryButtonText
      : palette.text;

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
        <Text className="text-center text-[12px] font-t3-bold" style={{ color: textColor }}>
          {props.label}
        </Text>
      ) : null}
    </Pressable>
  );
}

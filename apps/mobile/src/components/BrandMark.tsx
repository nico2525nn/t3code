import { Image, View } from "react-native";

import { AppText as Text } from "./AppText";

const BRAND_MARK_SOURCE = require("../../../../assets/dev/blueprint-ios-1024.png");

export function BrandMark(props: {
  readonly compact?: boolean;
  readonly stageLabel?: string;
  readonly dark?: boolean;
}) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const stageLabel = props.stageLabel ?? "Alpha";
  const textColor = props.dark ? "#f5f5f4" : "#171717";
  const mutedColor = props.dark ? "rgba(245,245,244,0.72)" : "rgba(23,23,23,0.6)";
  const stageBackground = props.dark ? "rgba(255,255,255,0.08)" : "rgba(23,23,23,0.06)";

  return (
    <View className="flex-row items-center gap-3">
      <Image
        source={BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: compact ? 10 : 14,
        }}
      />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="text-[17px] font-t3-bold"
            style={{ color: textColor, letterSpacing: -0.4 }}
          >
            T3 Code
          </Text>
          <View
            className="rounded-full px-2 py-1"
            style={{
              backgroundColor: stageBackground,
            }}
          >
            <Text
              className="text-[10px] font-t3-bold uppercase"
              style={{ color: mutedColor, letterSpacing: 1.1 }}
            >
              {stageLabel}
            </Text>
          </View>
        </View>
        {!compact ? (
          <Text className="text-[12px] font-medium" style={{ color: mutedColor }}>
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}

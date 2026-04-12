import { Image, View, useColorScheme } from "react-native";

import { makeAppPalette } from "../lib/theme";
import { AppText as Text } from "./AppText";

const BRAND_MARK_SOURCE = require("../../../../assets/dev/blueprint-ios-1024.png");

export function BrandMark(props: {
  readonly compact?: boolean;
  readonly stageLabel?: string;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const stageLabel = props.stageLabel ?? "Alpha";

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
            style={{ color: palette.text, letterSpacing: -0.4 }}
          >
            T3 Code
          </Text>
          <View
            className="rounded-full px-2 py-1"
            style={{
              backgroundColor: palette.subtleBg,
            }}
          >
            <Text
              className="text-[10px] font-t3-bold uppercase"
              style={{ color: palette.textMuted, letterSpacing: 1.1 }}
            >
              {stageLabel}
            </Text>
          </View>
        </View>
        {!compact ? (
          <Text className="text-[12px] font-medium" style={{ color: palette.textMuted }}>
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}

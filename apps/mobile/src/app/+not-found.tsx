import { Link } from "expo-router";
import { Pressable, ScrollView, useColorScheme } from "react-native";

import { AppText as Text } from "../components/AppText";
import { makeAppPalette } from "../lib/theme";

export default function NotFoundRoute() {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      style={{ flex: 1, backgroundColor: palette.screenBackground }}
    >
      <Text className="text-[28px] font-t3-bold" selectable style={{ color: palette.text }}>
        Route not found
      </Text>
      <Link href="/" asChild>
        <Pressable
          style={{
            backgroundColor: palette.primaryButton,
            borderRadius: 999,
            paddingHorizontal: 20,
            paddingVertical: 14,
          }}
        >
          <Text className="text-[16px] font-t3-bold" style={{ color: palette.primaryButtonText }}>
            Return home
          </Text>
        </Pressable>
      </Link>
    </ScrollView>
  );
}

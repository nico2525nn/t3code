import { ActivityIndicator, StatusBar, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { makeAppPalette } from "../lib/theme";
import { AppText as Text } from "./AppText";
import { BrandMark } from "./BrandMark";

export function LoadingScreen(props: { readonly message: string }) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: palette.screenBackground, paddingTop: insets.top }}>
      <StatusBar
        barStyle={palette.statusBarStyle}
        backgroundColor={palette.screenBackground}
        translucent
      />
      <View className="flex-1 items-center justify-center gap-5 px-6">
        <BrandMark compact />
        <ActivityIndicator size="large" />
        <Text className="font-t3-bold text-lg text-slate-950 dark:text-slate-50">
          {props.message}
        </Text>
      </View>
    </View>
  );
}

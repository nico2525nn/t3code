import { ActivityIndicator, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "./AppText";
import { BrandMark } from "./BrandMark";

export function LoadingScreen(props: { readonly isDarkMode: boolean; readonly message: string }) {
  const insets = useSafeAreaInsets();
  const backgroundColor = props.isDarkMode ? "#020617" : "#f8fafc";

  return (
    <View style={{ flex: 1, backgroundColor, paddingTop: insets.top }}>
      <StatusBar
        barStyle={props.isDarkMode ? "light-content" : "dark-content"}
        backgroundColor={backgroundColor}
        translucent
      />
      <View className="flex-1 items-center justify-center gap-5 px-6">
        <BrandMark compact dark={props.isDarkMode} />
        <ActivityIndicator size="large" />
        <Text className="font-t3-bold text-lg text-slate-950 dark:text-slate-50">
          {props.message}
        </Text>
      </View>
    </View>
  );
}

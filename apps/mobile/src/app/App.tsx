import { useColorScheme } from "react-native";
import "./../../global.css";

import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LoadingScreen } from "../components/LoadingScreen";
import { MobileAppShell } from "./MobileAppShell";
import { useRemoteAppState } from "./useRemoteAppState";

export default function App() {
  const colorScheme = useColorScheme();
  const isDarkMode = colorScheme !== "light";
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
  });
  const app = useRemoteAppState();
  let content;

  if (!fontsLoaded || app.isLoadingSavedConnection) {
    content = <LoadingScreen isDarkMode={isDarkMode} message="Loading remote workspace…" />;
  } else if (app.reconnectingScreenVisible) {
    content = <LoadingScreen isDarkMode={isDarkMode} message="Reconnecting…" />;
  } else {
    content = <MobileAppShell app={app} isDarkMode={isDarkMode} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <BottomSheetModalProvider>
        <SafeAreaProvider>{content}</SafeAreaProvider>
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}

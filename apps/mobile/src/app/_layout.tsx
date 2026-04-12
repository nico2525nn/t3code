import "../../global.css";

import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import Stack from "expo-router/stack";
import { Platform, StatusBar, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LoadingScreen } from "../components/LoadingScreen";
import { makeAppPalette } from "../lib/theme";
import { RemoteAppStateProvider, useRemoteApp } from "../state/remote-app-state-provider";

function AppNavigator() {
  const app = useRemoteApp();
  const isDarkMode = useColorScheme() !== "light";
  const palette = makeAppPalette(isDarkMode);

  const newTaskScreenOptions = {
    contentStyle: { backgroundColor: palette.sheetBackground },
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [0.92],
    sheetGrabberVisible: true,
  };

  const connectionSheetScreenOptions = {
    contentStyle: { backgroundColor: palette.sheetBackground },
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [0.55, 0.7],
    sheetGrabberVisible: true,
  };

  if (app.isLoadingSavedConnection) {
    return <LoadingScreen message="Loading remote workspace…" />;
  }

  if (app.reconnectingScreenVisible) {
    return <LoadingScreen message="Reconnecting…" />;
  }

  return (
    <>
      <StatusBar
        barStyle={palette.statusBarStyle}
        backgroundColor={palette.statusBarBackground}
        translucent
      />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen
          name="index"
          options={{
            headerShown: Platform.OS === "ios",
            headerShadowVisible: false,
            headerTitle: "",
            headerTransparent: true,
            headerBlurEffect: "none",
          }}
        />
        <Stack.Screen name="connections" options={connectionSheetScreenOptions} />
        <Stack.Screen name="new" options={newTaskScreenOptions} />
        <Stack.Screen
          name="threads/[environmentId]/[threadId]"
          options={{
            animation: "slide_from_right",
            gestureEnabled: false,
            headerShown: false,
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
  });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <BottomSheetModalProvider>
        <SafeAreaProvider>
          <RemoteAppStateProvider>
            {fontsLoaded ? (
              <AppNavigator />
            ) : (
              <LoadingScreen message="Loading remote workspace…" />
            )}
          </RemoteAppStateProvider>
        </SafeAreaProvider>
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}

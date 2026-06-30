import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { RegistryContext } from "@effect/atom-react";
import { LoadingScreen } from "./components/LoadingScreen";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { AppNavigationProvider } from "./navigation/app-navigation";
import { RootNavigator } from "./navigation/RootNavigator";
import { appAtomRegistry } from "./state/atom-registry";

import "../global.css";

export default function App() {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
  });

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider statusBarTranslucent>
            <SafeAreaProvider>
              <AppNavigationProvider>
                {fontsLoaded ? (
                  <RootNavigator />
                ) : (
                  <LoadingScreen message="Loading remote workspace…" />
                )}
              </AppNavigationProvider>
            </SafeAreaProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}

import { CameraView, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { dismissRoute } from "../../lib/routes";
import { extractPairingUrlFromQrPayload } from "../../lib/pairingQr";
import { useRemoteApp } from "../../state/remote-app-state-provider";
import {
  buildPairingUrl,
  ConnectionSheetButton as SheetButton,
  makeConnectionSheetPalette as makePalette,
  parsePairingUrl,
} from "./connection-sheet-shared";

export function NewConnectionRouteScreen() {
  const app = useRemoteApp();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const palette = makePalette(isDarkMode);
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showScanner, setShowScanner] = useState(params.mode === "scan_qr");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerLocked, setScannerLocked] = useState(false);

  const connectDisabled =
    isSubmitting || app.connectionState === "connecting" || hostInput.trim().length === 0;

  useEffect(() => {
    const { host, code } = parsePairingUrl(app.connectionInput.pairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [app.connectionInput.pairingUrl]);

  useEffect(() => {
    if (app.connectionError) {
      setIsSubmitting(false);
    }
  }, [app.connectionError]);

  const handleHostChange = useCallback((value: string) => {
    setHostInput(value);
  }, []);

  const handleCodeChange = useCallback((value: string) => {
    setCodeInput(value);
  }, []);

  const openScanner = useCallback(async () => {
    if (cameraPermission?.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    Alert.alert("Camera access needed", "Allow camera access to scan a backend pairing QR code.");
  }, [cameraPermission?.granted, requestCameraPermission]);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerLocked(false);
  }, []);

  const handleQrScan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked) {
        return;
      }

      setScannerLocked(true);

      try {
        const pairingUrl = extractPairingUrlFromQrPayload(data);
        const { host, code } = parsePairingUrl(pairingUrl);
        setHostInput(host);
        setCodeInput(code);
        app.onChangeConnectionPairingUrl(pairingUrl);
        setShowScanner(false);
      } catch (error) {
        Alert.alert(
          "Invalid QR code",
          error instanceof Error ? error.message : "Scanned QR code was not recognized.",
        );
      } finally {
        setTimeout(() => {
          setScannerLocked(false);
        }, 600);
      }
    },
    [app, scannerLocked],
  );

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);

    try {
      const pairingUrl = buildPairingUrl(hostInput, codeInput);
      app.onChangeConnectionPairingUrl(pairingUrl);
      await app.onConnectPress(pairingUrl);
      dismissRoute(router);
    } catch {
      setIsSubmitting(false);
    }
  }, [app, codeInput, hostInput, router]);

  return (
    <View
      collapsable={false}
      style={{
        flex: 1,
        backgroundColor: palette.sheet,
        paddingHorizontal: 20,
        paddingTop: 28,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
      }}
    >
      <View className="flex-row items-start justify-between gap-3 pb-4">
        <View className="flex-1">
          <Text
            className="text-[24px] font-t3-bold"
            style={{ color: palette.text, letterSpacing: -0.2 }}
          >
            Add backend
          </Text>
        </View>

        <Pressable
          className="h-11 w-11 items-center justify-center rounded-full"
          onPress={() => {
            if (showScanner) {
              closeScanner();
            } else {
              void openScanner();
            }
          }}
          style={{
            backgroundColor: palette.secondaryButton,
            borderWidth: 1,
            borderColor: palette.border,
          }}
        >
          <SymbolView
            name={showScanner ? "xmark" : "qrcode.viewfinder"}
            size={showScanner ? 14 : 18}
            tintColor={palette.text}
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </View>

      <View
        collapsable={false}
        style={{
          flex: 1,
          paddingBottom: 8,
        }}
      >
        <View collapsable={false} className="gap-5">
          {showScanner ? (
            cameraPermission?.granted ? (
              <View className="overflow-hidden rounded-[24px]" style={{ borderCurve: "continuous" }}>
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleQrScan}
                  style={{ aspectRatio: 1, width: "100%" }}
                />
              </View>
            ) : (
              <View
                className="items-center gap-3 rounded-[24px] px-5 py-8"
                style={{ backgroundColor: palette.card, borderCurve: "continuous" }}
              >
                <Text
                  className="text-center text-[14px] leading-[20px]"
                  style={{ color: palette.muted }}
                >
                  Camera permission is required to scan a QR code.
                </Text>
                <SheetButton
                  compact
                  icon="camera"
                  label="Allow camera"
                  palette={palette}
                  tone="secondary"
                  onPress={() => {
                    void openScanner();
                  }}
                />
              </View>
            )
          ) : (
            <View
              collapsable={false}
              className="gap-4 rounded-[24px] p-4"
              style={{ backgroundColor: palette.card }}
            >
              <View collapsable={false} className="gap-1.5">
                <Text
                  className="text-[11px] font-t3-bold uppercase"
                  style={{ color: palette.muted, letterSpacing: 0.8 }}
                >
                  Host
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="192.168.1.100:8080"
                  placeholderTextColor={palette.placeholder}
                  value={hostInput}
                  onChangeText={handleHostChange}
                  className="rounded-[14px] px-4 py-3.5 text-[15px]"
                  style={{
                    backgroundColor: palette.inputBackground,
                    borderWidth: 1,
                    borderColor: palette.inputBorder,
                    color: palette.text,
                  }}
                />
              </View>

              <View collapsable={false} className="gap-1.5">
                <Text
                  className="text-[11px] font-t3-bold uppercase"
                  style={{ color: palette.muted, letterSpacing: 0.8 }}
                >
                  Pairing code
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="abc-123-xyz"
                  placeholderTextColor={palette.placeholder}
                  value={codeInput}
                  onChangeText={handleCodeChange}
                  className="rounded-[14px] px-4 py-3.5 text-[15px]"
                  style={{
                    backgroundColor: palette.inputBackground,
                    borderWidth: 1,
                    borderColor: palette.inputBorder,
                    color: palette.text,
                  }}
                />
              </View>

              {app.connectionError ? <ErrorBanner message={app.connectionError} /> : null}

              <SheetButton
                icon="plus"
                label={
                  isSubmitting || app.connectionState === "connecting" ? "Pairing…" : "Add backend"
                }
                disabled={connectDisabled}
                palette={palette}
                tone="primary"
                onPress={() => {
                  void handleSubmit();
                }}
              />
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

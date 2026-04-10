import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { MenuView } from "@react-native-menu/menu";
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform, Pressable, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ConnectedEnvironmentSummary } from "../../app/useRemoteAppState";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import type { RemoteConnectionInput } from "../../lib/connection";
import { extractPairingUrlFromQrPayload } from "../../lib/pairingQr";
import type { RemoteClientConnectionState } from "../../lib/remoteClient";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

export interface ConnectionSheetProps {
  readonly visible: boolean;
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly connectionInput: RemoteConnectionInput;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly onRequestClose: () => void;
  readonly onChangePairingUrl: (pairingUrl: string) => void;
  readonly onConnect: () => void;
  readonly onUpdateEnvironment: (
    environmentId: string,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => Promise<void>;
  readonly onRemoveEnvironment: (environmentId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePairingUrl(url: string): { host: string; code: string } {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "" };

  try {
    const parsed = new URL(trimmed);
    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return { host: parsed.toString().replace(/\/$/, ""), code };
  } catch {
    return { host: trimmed, code: "" };
  }
}

function buildPairingUrl(host: string, code: string): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  if (!c) return h;

  try {
    const url = new URL(h.includes("://") ? h : `https://${h}`);
    url.hash = new URLSearchParams([["token", c]]).toString();
    return url.toString();
  } catch {
    return `${h}#token=${c}`;
  }
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function makePalette(isDarkMode: boolean) {
  if (isDarkMode) {
    return {
      sheet: "rgba(18,20,23,0.98)",
      card: "#1f2329",
      cardAlt: "#242a31",
      border: "rgba(255,255,255,0.06)",
      text: "#f8fafc",
      muted: "#94a3b8",
      subtle: "#cbd5e1",
      accent: "#f59e0b",
      accentSubtle: "rgba(245,158,11,0.12)",
      iconBg: "rgba(245,158,11,0.10)",
      inputBackground: "#171b20",
      inputBorder: "rgba(255,255,255,0.06)",
      primaryButton: "#f8fafc",
      primaryButtonText: "#171717",
      secondaryButton: "rgba(255,255,255,0.05)",
      secondaryButtonText: "#f8fafc",
      dangerButton: "rgba(190,24,93,0.14)",
      dangerBorder: "rgba(244,114,182,0.18)",
      dangerText: "#fda4af",
      placeholder: "#64748b",
      cardShadow: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.18,
        shadowRadius: 8,
        elevation: 4,
      } as const,
      separator: "rgba(255,255,255,0.04)",
    };
  }

  return {
    sheet: "rgba(246,244,239,0.98)",
    card: "#fffdf9",
    cardAlt: "#f8f4ec",
    border: "rgba(23,23,23,0.06)",
    text: "#171717",
    muted: "#78716c",
    subtle: "#57534e",
    accent: "#a16207",
    accentSubtle: "rgba(161,98,7,0.08)",
    iconBg: "rgba(161,98,7,0.07)",
    inputBackground: "#ffffff",
    inputBorder: "rgba(23,23,23,0.06)",
    primaryButton: "#171717",
    primaryButtonText: "#fafaf9",
    secondaryButton: "#f1ece3",
    secondaryButtonText: "#171717",
    dangerButton: "#fff1f2",
    dangerBorder: "rgba(225,29,72,0.10)",
    dangerText: "#be123c",
    placeholder: "#94a3b8",
    cardShadow: {
      shadowColor: "rgba(23,23,23,0.08)",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 1,
      shadowRadius: 16,
      elevation: 3,
    } as const,
    separator: "rgba(23,23,23,0.04)",
  };
}

// ---------------------------------------------------------------------------
// Shared button
// ---------------------------------------------------------------------------

function SheetButton(props: {
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly compact?: boolean;
  readonly palette: ReturnType<typeof makePalette>;
  readonly onPress: () => void;
}) {
  const tone = props.tone ?? "secondary";
  const colors =
    tone === "primary"
      ? {
          backgroundColor: props.palette.primaryButton,
          borderColor: "transparent",
          textColor: props.palette.primaryButtonText,
        }
      : tone === "danger"
        ? {
            backgroundColor: props.palette.dangerButton,
            borderColor: props.palette.dangerBorder,
            textColor: props.palette.dangerText,
          }
        : {
            backgroundColor: props.palette.secondaryButton,
            borderColor: props.palette.border,
            textColor: props.palette.secondaryButtonText,
          };

  const primaryShadow =
    tone === "primary"
      ? Platform.select({
          ios: {
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.14,
            shadowRadius: 6,
          },
          android: { elevation: 3 },
        })
      : undefined;

  return (
    <Pressable
      className={
        props.compact
          ? "min-h-[42px] flex-row items-center justify-center gap-1.5 rounded-[14px] px-3.5 py-2.5"
          : "min-h-[48px] flex-row items-center justify-center gap-2 rounded-[16px] px-4 py-3"
      }
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        {
          backgroundColor: colors.backgroundColor,
          borderWidth: tone === "primary" ? 0 : 1,
          borderColor: colors.borderColor,
          opacity: props.disabled ? 0.5 : 1,
        },
        primaryShadow,
      ]}
    >
      <SymbolView
        name={props.icon}
        size={props.compact ? 13 : 14}
        tintColor={colors.textColor}
        type="monochrome"
      />
      <Text
        className="text-[12px] font-t3-bold uppercase"
        style={{ color: colors.textColor, letterSpacing: 0.8 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Environment card (compact single row)
// ---------------------------------------------------------------------------

function EnvironmentCard(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly palette: ReturnType<typeof makePalette>;
  readonly onPress: () => void;
  readonly onRemove: (environmentId: string) => void;
}) {
  return (
    <Pressable
      className="flex-row items-center gap-3 rounded-[18px] px-4 py-3.5"
      style={[
        {
          backgroundColor: props.palette.card,
          borderWidth: 1,
          borderColor: props.palette.border,
        },
        props.palette.cardShadow,
      ]}
      onPress={props.onPress}
    >
      <ConnectionStatusDot state={props.environment.connectionState} pulse={false} size={8} />

      <View className="flex-1 gap-0.5">
        <Text
          className="text-[16px] font-t3-bold leading-[21px]"
          style={{ color: props.palette.text }}
          numberOfLines={1}
        >
          {props.environment.environmentLabel}
        </Text>
        <Text
          className="text-[12px] leading-[16px]"
          style={{ color: props.palette.muted }}
          numberOfLines={1}
        >
          {props.environment.displayUrl}
        </Text>
      </View>

      <Pressable
        className="h-9 w-9 items-center justify-center rounded-[12px]"
        style={{
          backgroundColor: props.palette.dangerButton,
          borderWidth: 1,
          borderColor: props.palette.dangerBorder,
        }}
        onPress={(e) => {
          e.stopPropagation();
          props.onRemove(props.environment.environmentId);
        }}
        hitSlop={4}
      >
        <SymbolView name="trash" size={13} tintColor={props.palette.dangerText} type="monochrome" />
      </Pressable>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Edit backend (nested sheet)
// ---------------------------------------------------------------------------

function EnvironmentDetailSheet(props: {
  readonly environment: ConnectedEnvironmentSummary | null;
  readonly palette: ReturnType<typeof makePalette>;
  readonly bottomInset: number;
  readonly onDismiss: () => void;
  readonly onSave: (
    environmentId: string,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => void;
  readonly onRemove: (environmentId: string) => void;
}) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const [label, setLabel] = useState("");
  const [displayUrl, setDisplayUrl] = useState("");
  const env = props.environment;

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    if (env) {
      setLabel(env.environmentLabel);
      setDisplayUrl(env.displayUrl);
      sheet.present();
    } else {
      sheet.dismiss();
    }
  }, [env]);

  const renderBackdrop = useCallback(
    (backdropProps: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.24}
        pressBehavior="close"
      />
    ),
    [],
  );

  const hasChanges =
    env !== null &&
    (label.trim() !== env.environmentLabel || displayUrl.trim() !== env.displayUrl);

  return (
    <BottomSheetModal
      ref={sheetRef}
      stackBehavior="push"
      index={0}
      snapPoints={["52%"]}
      enableDynamicSizing={false}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={props.onDismiss}
      backgroundStyle={{ backgroundColor: props.palette.sheet }}
      handleIndicatorStyle={{ backgroundColor: "rgba(120,113,108,0.32)" }}
    >
      <BottomSheetView style={{ flex: 1 }}>
        <View className="gap-5 px-5 pt-1">
          <View className="flex-row items-center gap-3">
            {env ? (
              <ConnectionStatusDot state={env.connectionState} pulse={false} size={8} />
            ) : null}
            <Text
              className="text-[24px] font-t3-bold"
              style={{ color: props.palette.text, letterSpacing: -0.2 }}
            >
              Edit backend
            </Text>
          </View>

          <View className="gap-2">
            <Text
              className="text-[11px] font-t3-bold uppercase"
              style={{ color: props.palette.muted, letterSpacing: 0.8 }}
            >
              Label
            </Text>
            <TextInput
              autoCapitalize="words"
              autoCorrect={false}
              placeholder="My MacBook Pro"
              placeholderTextColor={props.palette.placeholder}
              value={label}
              onChangeText={setLabel}
              className="rounded-[14px] px-4 py-3.5 text-[15px]"
              style={{
                backgroundColor: props.palette.inputBackground,
                borderWidth: 1,
                borderColor: props.palette.inputBorder,
                color: props.palette.text,
              }}
            />
          </View>

          <View className="gap-2">
            <Text
              className="text-[11px] font-t3-bold uppercase"
              style={{ color: props.palette.muted, letterSpacing: 0.8 }}
            >
              Host
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="http://192.168.1.100:8080/"
              placeholderTextColor={props.palette.placeholder}
              value={displayUrl}
              onChangeText={setDisplayUrl}
              className="rounded-[14px] px-4 py-3.5 text-[15px]"
              style={{
                backgroundColor: props.palette.inputBackground,
                borderWidth: 1,
                borderColor: props.palette.inputBorder,
                color: props.palette.text,
              }}
            />
          </View>

          <View
            className="flex-row gap-3"
            style={{ paddingBottom: Math.max(props.bottomInset, 16) }}
          >
            <View className="flex-1">
              <SheetButton
                icon="checkmark"
                label="Save"
                disabled={!hasChanges}
                palette={props.palette}
                tone="primary"
                onPress={() => {
                  if (env) {
                    props.onSave(env.environmentId, {
                      label: label.trim(),
                      displayUrl: displayUrl.trim(),
                    });
                    props.onDismiss();
                  }
                }}
              />
            </View>
            <View className="flex-1">
              <SheetButton
                icon="xmark"
                label="Cancel"
                palette={props.palette}
                tone="secondary"
                onPress={props.onDismiss}
              />
            </View>
          </View>
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

// ---------------------------------------------------------------------------
// Add backend (nested sheet — manual entry + optional QR scanner)
// ---------------------------------------------------------------------------

function AddBackendSheet(props: {
  readonly visible: boolean;
  readonly startWithScanner: boolean;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly palette: ReturnType<typeof makePalette>;
  readonly bottomInset: number;
  readonly onDismiss: () => void;
  readonly onChangePairingUrl: (url: string) => void;
  readonly onConnect: () => void;
}) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [scannerPaused, setScannerPaused] = useState(false);

  const connectDisabled =
    props.connectionState === "connecting" || hostInput.trim().length === 0;

  const snapPoints = useMemo<(string | number)[]>(
    () => [scannerVisible ? "82%" : "54%"],
    [scannerVisible],
  );

  // Present / dismiss
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    if (props.visible) {
      setHostInput("");
      setCodeInput("");
      setScannerError(null);
      setScannerPaused(false);

      if (props.startWithScanner) {
        setScannerVisible(true);
        if (!cameraPermission?.granted && cameraPermission?.canAskAgain !== false) {
          void requestCameraPermission().catch(() => {});
        }
      } else {
        setScannerVisible(false);
      }

      sheet.present();
    } else {
      sheet.dismiss();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  // Sync fields → parent
  const syncUrl = useCallback(
    (host: string, code: string) => {
      props.onChangePairingUrl(buildPairingUrl(host, code));
    },
    [props.onChangePairingUrl],
  );

  const handleHostChange = useCallback(
    (v: string) => {
      setHostInput(v);
      syncUrl(v, codeInput);
    },
    [codeInput, syncUrl],
  );

  const handleCodeChange = useCallback(
    (v: string) => {
      setCodeInput(v);
      syncUrl(hostInput, v);
    },
    [hostInput, syncUrl],
  );

  const handleToggleScanner = useCallback(() => {
    setScannerVisible((v) => {
      if (!v) {
        setScannerError(null);
        setScannerPaused(false);
        if (!cameraPermission?.granted && cameraPermission?.canAskAgain !== false) {
          void requestCameraPermission().catch(() => {});
        }
      }
      return !v;
    });
  }, [cameraPermission?.canAskAgain, cameraPermission?.granted, requestCameraPermission]);

  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      if (scannerPaused) return;
      setScannerPaused(true);
      try {
        const url = extractPairingUrlFromQrPayload(result.data);
        const { host, code } = parsePairingUrl(url);
        setHostInput(host);
        setCodeInput(code);
        props.onChangePairingUrl(url);
        setScannerVisible(false);
      } catch (error) {
        setScannerError(
          error instanceof Error
            ? error.message
            : "Could not read a pairing URL from that QR code.",
        );
        setScannerPaused(false);
      }
    },
    [props.onChangePairingUrl, scannerPaused],
  );

  const renderBackdrop = useCallback(
    (backdropProps: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.24}
        pressBehavior="close"
      />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      stackBehavior="push"
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={props.onDismiss}
      backgroundStyle={{ backgroundColor: props.palette.sheet }}
      handleIndicatorStyle={{ backgroundColor: "rgba(120,113,108,0.32)" }}
    >
      <BottomSheetView style={{ flex: 1 }}>
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 4,
            paddingBottom: Math.max(props.bottomInset, 16),
            gap: 20,
          }}
        >
          <Text
            className="text-[24px] font-t3-bold"
            style={{ color: props.palette.text, letterSpacing: -0.2 }}
          >
            Add backend
          </Text>

          {/* QR scanner */}
          {scannerVisible ? (
            <View
              className="gap-3 rounded-[18px] p-3"
              style={{
                backgroundColor: props.palette.cardAlt,
                borderWidth: 1,
                borderColor: props.palette.border,
              }}
            >
              {!cameraPermission ? (
                <Text
                  className="text-[13px] leading-[18px]"
                  style={{ color: props.palette.subtle }}
                >
                  Checking camera permission…
                </Text>
              ) : cameraPermission.granted ? (
                <>
                  <View
                    className="overflow-hidden rounded-[14px]"
                    style={{
                      height: 200,
                      borderWidth: 1,
                      borderColor: props.palette.border,
                      backgroundColor: "#000000",
                    }}
                  >
                    <CameraView
                      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                      facing="back"
                      onBarcodeScanned={scannerPaused ? undefined : handleBarcodeScanned}
                      onMountError={(error) => setScannerError(error.message)}
                      style={{ flex: 1 }}
                    />
                  </View>
                  <Text
                    className="text-[12px] leading-[17px]"
                    style={{ color: props.palette.subtle }}
                  >
                    Point the camera at a pairing QR code.
                  </Text>
                  {scannerPaused ? (
                    <SheetButton
                      icon="arrow.clockwise"
                      label="Scan again"
                      palette={props.palette}
                      tone="secondary"
                      compact
                      onPress={() => {
                        setScannerError(null);
                        setScannerPaused(false);
                      }}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <Text
                    className="text-[12px] leading-[17px]"
                    style={{ color: props.palette.subtle }}
                  >
                    Camera access is required to scan a pairing QR code.
                  </Text>
                  {cameraPermission.canAskAgain ? (
                    <SheetButton
                      icon="camera"
                      label="Allow camera"
                      palette={props.palette}
                      tone="secondary"
                      compact
                      onPress={() => void requestCameraPermission().catch(() => {})}
                    />
                  ) : (
                    <SheetButton
                      icon="gear"
                      label="Open settings"
                      palette={props.palette}
                      tone="secondary"
                      compact
                      onPress={() => void Linking.openSettings().catch(() => {})}
                    />
                  )}
                </>
              )}
              {scannerError ? <ErrorBanner message={scannerError} /> : null}
            </View>
          ) : null}

          {/* Host field */}
          <View className="gap-1.5">
            <Text
              className="text-[11px] font-t3-bold uppercase"
              style={{ color: props.palette.muted, letterSpacing: 0.8 }}
            >
              Host
            </Text>
            <View className="flex-row items-center gap-2">
              <View className="flex-1">
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="192.168.1.100:8080"
                  placeholderTextColor={props.palette.placeholder}
                  value={hostInput}
                  onChangeText={handleHostChange}
                  className="rounded-[14px] px-4 py-3.5 text-[15px]"
                  style={{
                    backgroundColor: props.palette.inputBackground,
                    borderWidth: 1,
                    borderColor: props.palette.inputBorder,
                    color: props.palette.text,
                  }}
                />
              </View>
              <Pressable
                className="h-[50px] w-[50px] items-center justify-center rounded-[14px]"
                style={{
                  backgroundColor: scannerVisible
                    ? props.palette.accent
                    : props.palette.secondaryButton,
                  borderWidth: scannerVisible ? 0 : 1,
                  borderColor: props.palette.border,
                }}
                onPress={handleToggleScanner}
              >
                <SymbolView
                  name={scannerVisible ? "xmark" : "qrcode.viewfinder"}
                  size={20}
                  tintColor={
                    scannerVisible
                      ? props.palette.primaryButtonText
                      : props.palette.secondaryButtonText
                  }
                  type="monochrome"
                />
              </Pressable>
            </View>
          </View>

          {/* Pairing code field */}
          <View className="gap-1.5">
            <Text
              className="text-[11px] font-t3-bold uppercase"
              style={{ color: props.palette.muted, letterSpacing: 0.8 }}
            >
              Pairing code
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="abc-123-xyz"
              placeholderTextColor={props.palette.placeholder}
              value={codeInput}
              onChangeText={handleCodeChange}
              className="rounded-[14px] px-4 py-3.5 text-[15px]"
              style={{
                backgroundColor: props.palette.inputBackground,
                borderWidth: 1,
                borderColor: props.palette.inputBorder,
                color: props.palette.text,
              }}
            />
          </View>

          {props.connectionError ? <ErrorBanner message={props.connectionError} /> : null}

          <SheetButton
            icon="plus"
            label={props.connectionState === "connecting" ? "Pairing…" : "Add backend"}
            disabled={connectDisabled}
            palette={props.palette}
            tone="primary"
            onPress={props.onConnect}
          />
        </BottomSheetScrollView>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

// ---------------------------------------------------------------------------
// Main connection sheet
// ---------------------------------------------------------------------------

const ADD_MENU_ACTIONS = [
  {
    id: "scan_qr",
    title: "Scan QR Code",
    image: "qrcode.viewfinder",
  },
  {
    id: "enter_manually",
    title: "Enter Manually",
    image: "keyboard",
  },
] as const;

export function ConnectionSheet(props: ConnectionSheetProps) {
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const palette = makePalette(isDarkMode);
  const sheetRef = useRef<BottomSheetModal>(null);

  const [editingEnvironment, setEditingEnvironment] =
    useState<ConnectedEnvironmentSummary | null>(null);
  const [addSheetVisible, setAddSheetVisible] = useState(false);
  const [addSheetStartWithScanner, setAddSheetStartWithScanner] = useState(false);

  const dismissible = props.connectedEnvironments.length > 0;
  const hasEnvironments = props.connectedEnvironments.length > 0;

  const snapPoints = useMemo<(string | number)[]>(
    () => [hasEnvironments ? "52%" : "38%"],
    [hasEnvironments],
  );

  const renderBackdrop = useCallback(
    (backdropProps: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.18}
        pressBehavior={dismissible ? "close" : "none"}
      />
    ),
    [dismissible],
  );

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    if (props.visible) {
      sheet.present();
    } else {
      sheet.dismiss();
    }
  }, [props.visible]);

  useEffect(() => {
    if (!props.visible) {
      setEditingEnvironment(null);
      setAddSheetVisible(false);
    }
  }, [props.visible]);

  // When there are no backends, open the add flow automatically
  useEffect(() => {
    if (props.visible && !dismissible) {
      setAddSheetStartWithScanner(false);
      setAddSheetVisible(true);
    }
  }, [props.visible, dismissible]);

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { nativeEvent: { event: string } }) => {
      if (nativeEvent.event === "scan_qr") {
        setAddSheetStartWithScanner(true);
        setAddSheetVisible(true);
      } else if (nativeEvent.event === "enter_manually") {
        setAddSheetStartWithScanner(false);
        setAddSheetVisible(true);
      }
    },
    [],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      stackBehavior="push"
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose={dismissible}
      backdropComponent={renderBackdrop}
      onDismiss={props.onRequestClose}
      backgroundStyle={{ backgroundColor: palette.sheet }}
      handleIndicatorStyle={{ backgroundColor: "rgba(120,113,108,0.32)" }}
    >
      <BottomSheetView style={{ flex: 1 }}>
        {/* Header */}
        <View className="flex-row items-center justify-between px-5 pb-4 pt-1">
          <View className="flex-1 gap-1">
            <Text
              className="text-[28px] font-t3-bold"
              style={{ color: palette.text, letterSpacing: -0.3 }}
            >
              Backends
            </Text>
            <Text
              className="text-[14px] leading-[20px]"
              style={{ color: palette.muted }}
            >
              Manage your connected environments.
            </Text>
          </View>

          {/* + button with native menu */}
          <MenuView actions={[...ADD_MENU_ACTIONS]} onPressAction={handleMenuAction}>
            <Pressable
              className="h-11 w-11 items-center justify-center rounded-full"
              style={{
                backgroundColor: palette.primaryButton,
                ...Platform.select({
                  ios: {
                    shadowColor: "#000",
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.12,
                    shadowRadius: 4,
                  },
                  android: { elevation: 3 },
                }),
              }}
            >
              <SymbolView
                name="plus"
                size={18}
                tintColor={palette.primaryButtonText}
                type="monochrome"
                weight="semibold"
              />
            </Pressable>
          </MenuView>
        </View>

        {/* Backend list */}
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 4,
            paddingBottom: Math.max(insets.bottom, 16) + 12,
            gap: 10,
          }}
        >
          {hasEnvironments ? (
            props.connectedEnvironments.map((environment) => (
              <EnvironmentCard
                key={environment.environmentId}
                environment={environment}
                palette={palette}
                onPress={() => setEditingEnvironment(environment)}
                onRemove={props.onRemoveEnvironment}
              />
            ))
          ) : (
            <View
              className="items-center gap-3 rounded-[20px] px-6 py-8"
              style={{
                backgroundColor: palette.card,
                borderWidth: 1,
                borderColor: palette.border,
              }}
            >
              <View
                className="h-12 w-12 items-center justify-center rounded-[16px]"
                style={{ backgroundColor: palette.iconBg }}
              >
                <SymbolView
                  name="point.3.connected.trianglepath.dotted"
                  size={20}
                  tintColor={palette.accent}
                  type="monochrome"
                />
              </View>
              <Text
                className="text-center text-[14px] leading-[20px]"
                style={{ color: palette.muted }}
              >
                No backends connected yet.{"\n"}Tap{" "}
                <Text className="font-t3-bold" style={{ color: palette.text }}>
                  +
                </Text>{" "}
                to add one.
              </Text>
            </View>
          )}
        </BottomSheetScrollView>
      </BottomSheetView>

      {/* Nested: Add backend */}
      <AddBackendSheet
        visible={addSheetVisible}
        startWithScanner={addSheetStartWithScanner}
        connectionState={props.connectionState}
        connectionError={props.connectionError}
        palette={palette}
        bottomInset={insets.bottom}
        onDismiss={() => setAddSheetVisible(false)}
        onChangePairingUrl={props.onChangePairingUrl}
        onConnect={props.onConnect}
      />

      {/* Nested: Edit backend */}
      <EnvironmentDetailSheet
        environment={editingEnvironment}
        palette={palette}
        bottomInset={insets.bottom}
        onDismiss={() => setEditingEnvironment(null)}
        onSave={(environmentId, updates) => {
          void props.onUpdateEnvironment(environmentId, updates);
        }}
        onRemove={props.onRemoveEnvironment}
      />
    </BottomSheetModal>
  );
}

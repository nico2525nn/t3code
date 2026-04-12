import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from "@gorhom/bottom-sheet";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Platform,
  Pressable,
  ScrollView,
  View,
  useColorScheme,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ConnectedEnvironmentSummary } from "../../state/use-remote-app-state";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import {
  ConnectionSheetButton as SheetButton,
  makeConnectionSheetPalette as makePalette,
  type ConnectionSheetPalette,
} from "./connection-sheet-shared";

export interface ConnectionSheetProps {
  readonly visible: boolean;
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly onRequestClose: () => void;
  readonly onUpdateEnvironment: (
    environmentId: string,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => Promise<void>;
  readonly onRemoveEnvironment: (environmentId: string) => void;
}

// ---------------------------------------------------------------------------
function EnvironmentCard(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly palette: ConnectionSheetPalette;
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
  readonly palette: ConnectionSheetPalette;
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
    env !== null && (label.trim() !== env.environmentLabel || displayUrl.trim() !== env.displayUrl);

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
// Main connection sheet
// ---------------------------------------------------------------------------

export function ConnectionSheet(props: ConnectionSheetProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const palette = makePalette(isDarkMode);

  const [editingEnvironment, setEditingEnvironment] = useState<ConnectedEnvironmentSummary | null>(
    null,
  );

  const hasEnvironments = props.connectedEnvironments.length > 0;

  useEffect(() => {
    if (!props.visible) {
      setEditingEnvironment(null);
    }
  }, [props.visible]);

  const handleAddPress = useCallback(() => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          cancelButtonIndex: 2,
          options: ["Scan QR Code", "Enter Manually", "Cancel"],
          title: "Add backend",
        },
        (buttonIndex) => {
          console.log("[connections sheet] add action", buttonIndex);

          if (buttonIndex === 0) {
            router.push("/connections/new?mode=scan_qr");
            return;
          }

          if (buttonIndex === 1) {
            router.push("/connections/new");
          }
        },
      );
      return;
    }

    router.push("/connections/new");
  }, [router]);

  return (
    <View style={{ flex: 1, backgroundColor: palette.sheet }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 4,
          paddingBottom: Math.max(insets.bottom, 16) + 12,
          gap: 10,
        }}
      >
        {/* Header */}
        <View className="flex-row items-center justify-between pb-4 pt-1">
          <View className="flex-1 gap-1">
            <Text
              className="text-[28px] font-t3-bold"
              style={{ color: palette.text, letterSpacing: -0.3 }}
            >
              Backends
            </Text>
            <Text className="text-[14px] leading-[20px]" style={{ color: palette.muted }}>
              Manage your connected environments.
            </Text>
          </View>

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
            onPress={handleAddPress}
          >
            <SymbolView
              name="plus"
              size={18}
              tintColor={palette.primaryButtonText}
              type="monochrome"
              weight="semibold"
            />
          </Pressable>
        </View>

        {/* Backend list */}
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
      </ScrollView>

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
    </View>
  );
}

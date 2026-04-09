import { Modal, Pressable, ScrollView, View } from "react-native";
import { useColorScheme } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import type { ConnectedEnvironmentSummary } from "../../app/useRemoteAppState";
import type { RemoteConnectionInput } from "../../lib/connection";
import type { RemoteClientConnectionState } from "../../lib/remoteClient";

export interface ConnectionSheetProps {
  readonly visible: boolean;
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly connectionInput: RemoteConnectionInput;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly onRequestClose: () => void;
  readonly onChangePairingUrl: (pairingUrl: string) => void;
  readonly onConnect: () => void;
  readonly onClose: () => void;
  readonly onRemoveEnvironment: (environmentId: string) => void;
}

function makePalette(isDarkMode: boolean) {
  if (isDarkMode) {
    return {
      sheet: "#151618",
      panel: "#1d1e21",
      border: "rgba(255,255,255,0.08)",
      text: "#f4f3ef",
      muted: "#8f918f",
      input: "#1f2230",
      inputText: "#f8fafc",
      placeholder: "#6b7280",
      action: "#f97316",
      actionText: "#fff7ed",
      secondary: "#303440",
      secondaryText: "#f8fafc",
      danger: "#381624",
      dangerText: "#fda4af",
      accent: "#d8b27a",
    };
  }

  return {
    sheet: "#f2ece4",
    panel: "#fbf7f1",
    border: "#d7cdbf",
    text: "#1f1b17",
    muted: "#847b71",
    input: "#ffffff",
    inputText: "#1f2937",
    placeholder: "#94a3b8",
    action: "#2c2a2d",
    actionText: "#f8f4ee",
    secondary: "#ffffff",
    secondaryText: "#1f1b17",
    danger: "#fde7e7",
    dangerText: "#a11d33",
    accent: "#9a6b30",
  };
}

function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly palette: ReturnType<typeof makePalette>;
  readonly tone?: "primary" | "secondary" | "danger";
}) {
  const tone = props.tone ?? "secondary";
  const styles =
    tone === "primary"
      ? {
          backgroundColor: props.palette.action,
          color: props.palette.actionText,
        }
      : tone === "danger"
        ? {
            backgroundColor: props.palette.danger,
            color: props.palette.dangerText,
          }
        : {
            backgroundColor: props.palette.secondary,
            color: props.palette.secondaryText,
          };

  return (
    <Pressable
      className="min-h-[52px] items-center justify-center px-4 py-3"
      style={{ backgroundColor: styles.backgroundColor }}
      onPress={props.onPress}
    >
      <Text
        className="text-sm font-extrabold uppercase"
        style={{ color: styles.color, letterSpacing: 1 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ConnectionSheet(props: ConnectionSheetProps) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makePalette(isDarkMode);

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal
      visible={props.visible}
      onRequestClose={props.onRequestClose}
    >
      <View className="flex-1" style={{ backgroundColor: palette.sheet }}>
        <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
          <View className="gap-5 px-5 py-5">
            <View
              className="gap-4 px-4 py-4"
              style={{
                borderWidth: 1,
                borderColor: palette.border,
                backgroundColor: palette.panel,
              }}
            >
              <View className="gap-2">
                <Text
                  className="text-[11px] font-bold uppercase"
                  style={{ color: palette.accent, letterSpacing: 1.3 }}
                >
                  Pair environment
                </Text>
                <Text
                  className="text-[20px] font-extrabold leading-[24px]"
                  style={{ color: palette.text }}
                >
                  Add another backend
                </Text>
                <Text className="text-[14px] leading-[20px]" style={{ color: palette.muted }}>
                  Paste the pairing link from the web or desktop app. The mobile client will keep a
                  separate live connection for each paired environment.
                </Text>
              </View>

              <View className="gap-2">
                <Text
                  className="text-[11px] font-bold uppercase"
                  style={{ color: palette.muted, letterSpacing: 1.15 }}
                >
                  Pairing URL
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="https://backend.example.com/pair#token=..."
                  placeholderTextColor={palette.placeholder}
                  className="min-h-[56px] px-4 py-3 text-[15px]"
                  style={{
                    borderWidth: 1,
                    borderColor: palette.border,
                    backgroundColor: palette.input,
                    color: palette.inputText,
                  }}
                  value={props.connectionInput.pairingUrl}
                  onChangeText={props.onChangePairingUrl}
                />
              </View>

              <View className="flex-row gap-3">
                <View className="flex-1">
                  <ActionButton
                    label={props.connectionState === "connecting" ? "Pairing…" : "Add backend"}
                    onPress={props.onConnect}
                    palette={palette}
                    tone="primary"
                  />
                </View>
                {props.connectedEnvironments.length > 0 ? (
                  <View className="flex-1">
                    <ActionButton label="Close" onPress={props.onClose} palette={palette} />
                  </View>
                ) : null}
              </View>
            </View>

            {props.connectionError ? <ErrorBanner message={props.connectionError} /> : null}

            {props.connectedEnvironments.length > 0 ? (
              <View
                className="gap-3 px-4 py-4"
                style={{
                  borderWidth: 1,
                  borderColor: palette.border,
                  backgroundColor: palette.panel,
                }}
              >
                <Text
                  className="text-[11px] font-bold uppercase"
                  style={{ color: palette.accent, letterSpacing: 1.3 }}
                >
                  Connected backends
                </Text>

                {props.connectedEnvironments.map((environment) => (
                  <View
                    key={environment.environmentId}
                    className="gap-3 px-3 py-3"
                    style={{
                      borderWidth: 1,
                      borderColor: palette.border,
                    }}
                  >
                    <View className="gap-1">
                      <Text className="text-[16px] font-extrabold" style={{ color: palette.text }}>
                        {environment.environmentLabel}
                      </Text>
                      <Text className="text-[13px]" style={{ color: palette.muted }}>
                        {environment.displayUrl}
                      </Text>
                      <Text
                        className="text-[11px] font-bold uppercase"
                        style={{ color: palette.muted, letterSpacing: 1.05 }}
                      >
                        {environment.connectionState}
                      </Text>
                    </View>

                    {environment.connectionError ? (
                      <Text className="text-[12px] leading-[18px]" style={{ color: palette.muted }}>
                        {environment.connectionError}
                      </Text>
                    ) : null}

                    <ActionButton
                      label="Remove"
                      onPress={() => props.onRemoveEnvironment(environment.environmentId)}
                      palette={palette}
                      tone="danger"
                    />
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

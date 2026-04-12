import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View, useColorScheme } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useRemoteApp } from "../../state/remote-app-state-provider";
import type { ConnectedEnvironmentSummary } from "../../state/use-remote-app-state";
import { dismissRoute } from "../../lib/routes";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { makeConnectionSheetPalette as makePalette } from "./connection-sheet-shared";

function EnvironmentRow(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onRemove: (environmentId: string) => void;
  readonly onUpdate: (
    environmentId: string,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => void;
  readonly palette: ReturnType<typeof makePalette>;
}) {
  const [label, setLabel] = useState(props.environment.environmentLabel);
  const [url, setUrl] = useState(props.environment.displayUrl);

  const handleSave = useCallback(() => {
    props.onUpdate(props.environment.environmentId, {
      label: label.trim(),
      displayUrl: url.trim(),
    });
    props.onToggle();
  }, [label, url, props]);

  return (
    <Animated.View
      layout={LinearTransition.duration(250)}
      style={{ backgroundColor: props.palette.card }}
    >
      <Pressable className="flex-row items-center gap-3 px-4 py-3.5" onPress={props.onToggle}>
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

        <SymbolView
          name="chevron.down"
          size={12}
          tintColor={props.palette.muted}
          type="monochrome"
          style={{
            transform: [{ rotate: props.expanded ? "180deg" : "0deg" }],
          }}
        />
      </Pressable>

      {props.expanded ? (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          className="gap-3 px-4 pb-4"
        >
          <View className="gap-1.5">
            <Text
              className="text-[11px] font-t3-bold uppercase"
              style={{ color: props.palette.muted, letterSpacing: 0.8 }}
            >
              Label
            </Text>
            <TextInput
              autoCapitalize="words"
              autoCorrect={false}
              placeholder="My MacBook"
              placeholderTextColor={props.palette.placeholder}
              value={label}
              onChangeText={setLabel}
              className="rounded-[14px] px-4 py-3 text-[15px]"
              style={{
                backgroundColor: props.palette.inputBackground,
                borderWidth: 1,
                borderColor: props.palette.inputBorder,
                color: props.palette.text,
              }}
            />
          </View>

          <View className="gap-1.5">
            <Text
              className="text-[11px] font-t3-bold uppercase"
              style={{ color: props.palette.muted, letterSpacing: 0.8 }}
            >
              URL
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="192.168.1.100:8080"
              placeholderTextColor={props.palette.placeholder}
              value={url}
              onChangeText={setUrl}
              className="rounded-[14px] px-4 py-3 text-[15px]"
              style={{
                backgroundColor: props.palette.inputBackground,
                borderWidth: 1,
                borderColor: props.palette.inputBorder,
                color: props.palette.text,
              }}
            />
          </View>

          <View className="flex-row gap-2">
            <Pressable
              className="min-h-[42px] flex-1 flex-row items-center justify-center gap-1.5 rounded-[14px] px-3.5 py-2.5"
              onPress={handleSave}
              style={{
                backgroundColor: props.palette.primaryButton,
              }}
            >
              <SymbolView
                name="checkmark"
                size={13}
                tintColor={props.palette.primaryButtonText}
                type="monochrome"
              />
              <Text
                className="text-[12px] font-t3-bold uppercase"
                style={{
                  color: props.palette.primaryButtonText,
                  letterSpacing: 0.8,
                }}
              >
                Save
              </Text>
            </Pressable>

            <Pressable
              className="h-[42px] w-[42px] items-center justify-center rounded-[14px]"
              onPress={() => props.onRemove(props.environment.environmentId)}
              style={{
                backgroundColor: props.palette.dangerButton,
                borderWidth: 1,
                borderColor: props.palette.dangerBorder,
              }}
            >
              <SymbolView
                name="trash"
                size={14}
                tintColor={props.palette.dangerText}
                type="monochrome"
              />
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

export function ConnectionsRouteScreen() {
  const app = useRemoteApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const palette = makePalette(isDarkMode);
  const hasEnvironments = app.connectedEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleToggle = useCallback((environmentId: string) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);

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
          onPress={() => router.push("/connections/new")}
          style={{
            backgroundColor: palette.primaryButton,
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
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 8 }}
      >
        {hasEnvironments ? (
          <View
            collapsable={false}
            className="overflow-hidden rounded-[24px]"
            style={{ backgroundColor: palette.card }}
          >
            {app.connectedEnvironments.map((environment, index) => (
              <View
                key={environment.environmentId}
                collapsable={false}
                style={{
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: palette.border,
                }}
              >
                <EnvironmentRow
                  environment={environment}
                  expanded={expandedId === environment.environmentId}
                  onToggle={() => handleToggle(environment.environmentId)}
                  onRemove={app.onRemoveEnvironmentPress}
                  onUpdate={app.onUpdateEnvironment}
                  palette={palette}
                />
              </View>
            ))}
          </View>
        ) : (
          <View
            collapsable={false}
            className="items-center gap-3 rounded-[24px] px-6 py-8"
            style={{ backgroundColor: palette.card }}
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
    </View>
  );
}

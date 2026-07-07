import { useAuth } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import type { SavedRemoteConnection } from "../../lib/connection";
import { cn } from "../../lib/cn";
import { runtime } from "../../lib/runtime";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  useRemoteConnections,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { markConnectOnboardingCompleted } from "./connectOnboarding";
import {
  getEnvironmentConnectPublishState,
  linkEnvironmentToCloud,
  setEnvironmentPublishAgentActivity,
} from "./linkEnvironment";
import { refreshManagedRelayEnvironments } from "./managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";

type PublishTargetPhase = "checking" | "ready" | "published" | "unauthorized" | "error";

interface PublishTarget {
  readonly connection: SavedRemoteConnection;
  readonly phase: PublishTargetPhase;
  readonly linked: boolean;
  readonly managedTunnelActive: boolean;
  readonly publishAgentActivity: boolean;
  readonly error: string | null;
}

function pendingPublishTarget(connection: SavedRemoteConnection): PublishTarget {
  return {
    connection,
    phase: "checking",
    linked: false,
    managedTunnelActive: false,
    publishAgentActivity: false,
    error: null,
  };
}

/**
 * Post-sign-in onboarding sheet for T3 Connect. Offers to publish this
 * device's locally paired environments (managed tunnel + agent activity, both
 * defaulting on) when the paired session is authorized, then lists the
 * account's T3 Connect environments so every device can be connected right
 * away. Dismissing the sheet counts as completion — it never nags twice.
 */
export function ConnectOnboardingRouteScreen() {
  return hasCloudPublicConfig() ? <ConfiguredConnectOnboardingRouteScreen /> : null;
}

function ConfiguredConnectOnboardingRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { getToken, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { isLoadingSavedConnection, savedConnectionsById } = useSavedRemoteConnections();
  const { connectedEnvironments, onReconnectEnvironment } = useRemoteConnections();
  const { connectedCloudEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });

  // Dismissing the sheet (swipe, Skip, or Done) counts as completion.
  const completionPersistedRef = useRef(false);
  const persistCompletion = useCallback(() => {
    if (completionPersistedRef.current || !userId) {
      return;
    }
    completionPersistedRef.current = true;
    void (async () => {
      const result = await settlePromise(() => markConnectOnboardingCompleted(userId));
      reportAtomCommandResult(result, { label: "connect onboarding completion" });
    })();
  }, [userId]);

  useEffect(
    () => navigation.addListener("beforeRemove", persistCompletion),
    [navigation, persistCompletion],
  );

  const handleDone = useCallback(() => {
    persistCompletion();
    navigation.goBack();
  }, [navigation, persistCompletion]);

  const bearerConnections = useMemo(
    () =>
      Object.values(savedConnectionsById).filter((connection) => connection.bearerToken !== null),
    [savedConnectionsById],
  );

  const [targets, setTargets] = useState<ReadonlyArray<PublishTarget> | null>(null);
  const [publishEnvironment, setPublishEnvironment] = useState(true);
  const [publishAgentActivity, setPublishAgentActivity] = useState(true);
  const [isApplying, setIsApplying] = useState(false);

  const loadPublishTargets = useCallback(
    async (connections: ReadonlyArray<SavedRemoteConnection>) => {
      if (connections.length === 0) {
        setTargets([]);
        return;
      }
      setTargets(connections.map(pendingPublishTarget));
      const result = await settleAsyncResult(() =>
        runtime.runPromiseExit(
          Effect.forEach(
            connections,
            (connection) =>
              getEnvironmentConnectPublishState({ connection }).pipe(
                Effect.match({
                  onFailure: (error): PublishTarget => ({
                    ...pendingPublishTarget(connection),
                    phase: "error",
                    error: error.message,
                  }),
                  onSuccess: (state): PublishTarget => ({
                    connection,
                    phase:
                      state.canPublish === false
                        ? "unauthorized"
                        : state.linked && state.managedTunnelActive && state.publishAgentActivity
                          ? "published"
                          : "ready",
                    linked: state.linked,
                    managedTunnelActive: state.managedTunnelActive,
                    publishAgentActivity: state.publishAgentActivity,
                    error: null,
                  }),
                }),
              ),
            { concurrency: "unbounded" },
          ),
        ),
      );
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        const message =
          error instanceof Error ? error.message : "Could not check the environment link state.";
        setTargets(
          connections.map((connection) => ({
            ...pendingPublishTarget(connection),
            phase: "error" as const,
            error: message,
          })),
        );
        return;
      }
      setTargets(result.value);
    },
    [],
  );

  // Check authorization + link state once the locally saved connections are
  // ready. Loaded once per mount: reconnect churn in the registry must not
  // flip the section back to "checking" mid-interaction.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (isLoadingSavedConnection || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    void loadPublishTargets(bearerConnections);
  }, [bearerConnections, isLoadingSavedConnection, loadPublishTargets]);

  const publishableTargets = useMemo(
    () => (targets ?? []).filter((target) => target.phase === "ready"),
    [targets],
  );
  const targetConnections = useMemo(
    () => (targets ?? []).map((target) => target.connection),
    [targets],
  );

  const handlePublish = useCallback(async () => {
    const applicable = publishableTargets;
    if (applicable.length === 0 || (!publishEnvironment && !publishAgentActivity)) {
      return;
    }
    setIsApplying(true);
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    const clerkToken = tokenResult._tag === "Success" ? tokenResult.value : null;
    if (clerkToken === null) {
      setIsApplying(false);
      const error = tokenResult._tag === "Failure" ? squashAtomCommandFailure(tokenResult) : null;
      Alert.alert(
        "Publishing unavailable",
        error instanceof Error ? error.message : "Sign in to publish environments over T3 Connect.",
      );
      return;
    }

    const failures: Array<string> = [];
    await Promise.all(
      applicable.map(async (target) => {
        // Onboarding only ever enables: it links when something is missing and
        // never tears down an existing link or clears a preference.
        const needsLink = publishEnvironment
          ? !target.linked || !target.managedTunnelActive
          : !target.linked && publishAgentActivity;
        const applyEffect = Effect.gen(function* () {
          if (needsLink) {
            yield* linkEnvironmentToCloud({
              connection: target.connection,
              clerkToken,
              mode: publishEnvironment ? "managed" : "publish_only",
            });
          }
          if (publishAgentActivity && !target.publishAgentActivity) {
            yield* setEnvironmentPublishAgentActivity({
              connection: target.connection,
              publishAgentActivity: true,
            });
          }
        });
        const result = await settleAsyncResult(() => runtime.runPromiseExit(applyEffect));
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          failures.push(
            `${target.connection.environmentLabel}: ${
              error instanceof Error ? error.message : "Publishing failed."
            }`,
          );
        }
      }),
    );

    refreshManagedRelayEnvironments();
    await loadPublishTargets(targetConnections);
    setIsApplying(false);
    if (failures.length > 0) {
      Alert.alert("Couldn't publish every environment", failures.join("\n\n"));
    }
  }, [
    getToken,
    loadPublishTargets,
    publishAgentActivity,
    publishEnvironment,
    publishableTargets,
    targetConnections,
  ]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          gap: 24,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 24,
        }}
      >
        <View className="gap-1.5">
          <View className="flex-row items-start justify-between gap-3">
            <Text className="flex-1 text-2xl font-t3-bold text-foreground">Set up T3 Connect</Text>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleDone}
              className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
            >
              <Text className="text-xs font-t3-bold uppercase text-foreground-muted">Skip</Text>
            </Pressable>
          </View>
          <Text className="text-sm leading-normal text-foreground-muted">
            {
              "Mesh your devices together — publish this device's environments and connect the rest, all in one place."
            }
          </Text>
        </View>

        {isSignedIn ? (
          <>
            <PublishSection
              targets={targets}
              publishEnvironment={publishEnvironment}
              publishAgentActivity={publishAgentActivity}
              isApplying={isApplying}
              onPublishEnvironmentChange={setPublishEnvironment}
              onPublishAgentActivityChange={setPublishAgentActivity}
              onPublish={() => void handlePublish()}
              onRetry={() => void loadPublishTargets(targetConnections)}
            />

            <View className="gap-2">
              <Text className="px-2 text-sm font-t3-medium text-foreground-muted">
                Connect your environments
              </Text>
              <Text className="px-2 text-sm leading-normal text-foreground-muted">
                Environments published from your other devices are ready to connect here.
              </Text>
              <CloudEnvironmentRows
                connectedCloudEnvironments={connectedCloudEnvironments}
                onReconnectEnvironment={onReconnectEnvironment}
              />
            </View>
          </>
        ) : (
          <View collapsable={false} className="rounded-[24px] bg-card p-5">
            <Text className="text-sm leading-normal text-foreground-muted">
              Sign in to your T3 account to set up T3 Connect.
            </Text>
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          onPress={handleDone}
          className="min-h-[48px] items-center justify-center rounded-[18px] bg-card active:opacity-70"
        >
          <Text className="text-base font-t3-bold text-foreground">Done</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function PublishSection(props: {
  readonly targets: ReadonlyArray<PublishTarget> | null;
  readonly publishEnvironment: boolean;
  readonly publishAgentActivity: boolean;
  readonly isApplying: boolean;
  readonly onPublishEnvironmentChange: (enabled: boolean) => void;
  readonly onPublishAgentActivityChange: (enabled: boolean) => void;
  readonly onPublish: () => void;
  readonly onRetry: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const targets = props.targets;
  const isChecking = targets === null || targets.some((target) => target.phase === "checking");
  const publishableTargets = (targets ?? []).filter((target) => target.phase === "ready");
  const publishedTargets = (targets ?? []).filter((target) => target.phase === "published");
  const hasRetryableErrors = (targets ?? []).some((target) => target.phase === "error");
  const canPublish =
    publishableTargets.length > 0 &&
    (props.publishEnvironment || props.publishAgentActivity) &&
    !props.isApplying;

  if (targets !== null && targets.length === 0) {
    return (
      <View className="gap-2">
        <Text className="px-2 text-sm font-t3-medium text-foreground-muted">
          Publish this device
        </Text>
        <View collapsable={false} className="rounded-[24px] bg-card p-5">
          <Text className="text-sm leading-normal text-foreground-muted">
            {
              "No locally paired environments on this device yet. Pair an environment first and it can be published to your other devices from Settings."
            }
          </Text>
        </View>
      </View>
    );
  }

  if (isChecking) {
    return (
      <View className="gap-2">
        <Text className="px-2 text-sm font-t3-medium text-foreground-muted">
          Publish this device
        </Text>
        <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card p-6">
          <ActivityIndicator color={iconColor} />
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            Checking which environments can publish.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="gap-3">
      <SettingsSection title="Publish this device">
        {publishableTargets.length > 0 ? (
          <>
            <SettingsSwitchRow
              icon="antenna.radiowaves.left.and.right"
              label="Publish environment"
              disabled={props.isApplying}
              value={props.publishEnvironment}
              onValueChange={props.onPublishEnvironmentChange}
            />
            <SettingsSwitchRow
              icon="bolt.circle"
              label="Publish agent activity"
              disabled={props.isApplying}
              value={props.publishAgentActivity}
              onValueChange={props.onPublishAgentActivityChange}
            />
          </>
        ) : publishedTargets.length > 0 ? (
          <View className="p-4">
            <Text className="text-sm leading-normal text-foreground-muted">
              {"This device's environments already publish over T3 Connect."}
            </Text>
          </View>
        ) : (
          <View className="p-4">
            <Text className="text-sm leading-normal text-foreground-muted">
              {
                "This device's paired sessions aren't authorized to publish. Pair again with an administrative link to enable publishing."
              }
            </Text>
          </View>
        )}
      </SettingsSection>

      {publishableTargets.length > 0 ? (
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Make the environments paired with this device available to your other devices, and send
          agent activity for notifications and Live Activities.
        </Text>
      ) : null}

      {targets.map((target) => (
        <PublishTargetStatusRow key={target.connection.environmentId} target={target} />
      ))}

      {publishableTargets.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          disabled={!canPublish}
          onPress={props.onPublish}
          className={cn(
            "min-h-[48px] flex-row items-center justify-center gap-2 rounded-[18px] bg-primary px-5 active:opacity-70",
            !canPublish && "opacity-50",
          )}
        >
          {props.isApplying ? <ActivityIndicator color={primaryForeground} size="small" /> : null}
          <Text className="text-base font-t3-bold text-primary-foreground">
            {props.isApplying
              ? "Publishing..."
              : `Publish ${publishableTargets.length === 1 ? "environment" : `${publishableTargets.length} environments`}`}
          </Text>
        </Pressable>
      ) : null}

      {hasRetryableErrors ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.isApplying}
          onPress={props.onRetry}
          className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70 disabled:opacity-50"
        >
          <Text className="text-xs font-t3-bold text-foreground">Check again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function publishTargetStatusText(target: PublishTarget): string {
  switch (target.phase) {
    case "checking":
      return "Checking...";
    case "published":
      return "Already publishing";
    case "ready":
      return target.linked ? "Partially published — ready to update" : "Ready to publish";
    case "unauthorized":
      return "This device's session is not authorized to publish";
    case "error":
      return target.error ?? "Could not check the environment";
  }
}

function PublishTargetStatusRow(props: { readonly target: PublishTarget }) {
  const isError = props.target.phase === "error";
  return (
    <View className="flex-row items-baseline gap-2 px-2">
      <Text className="min-w-0 flex-shrink text-xs font-t3-bold text-foreground" numberOfLines={1}>
        {props.target.connection.environmentLabel}
      </Text>
      <Text
        className={cn(
          "min-w-0 flex-1 text-xs",
          isError ? "text-rose-500 dark:text-rose-400" : "text-foreground-muted",
        )}
        numberOfLines={3}
      >
        {publishTargetStatusText(props.target)}
      </Text>
    </View>
  );
}

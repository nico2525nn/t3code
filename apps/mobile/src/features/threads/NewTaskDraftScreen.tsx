import type { ComponentProps, ReactNode } from "react";
import { MenuView } from "@react-native-menu/menu";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo } from "react";
import { Image, Pressable, ScrollView, useColorScheme, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ModelSelection } from "@t3tools/contracts";
import { CLAUDE_CODE_EFFORT_OPTIONS } from "@t3tools/contracts";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";

import {
  type DraftComposerImageAttachment,
  convertPastedImagesToAttachments,
  pickComposerImages,
} from "../../lib/composerImages";
import { buildThreadRoutePath } from "../../lib/routes";
import { makeAppPalette } from "../../lib/theme";
import { useRemoteApp } from "../../state/remote-app-state-provider";
import { branchBadgeLabel } from "./new-task-flow-provider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { PasteEventPayload, TextInputWrapper } from "expo-paste-input";

function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly variant?: "circle" | "pill" | "primary";
  readonly disabled?: boolean;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const variant = props.variant ?? "circle";
  const backgroundColor =
    variant === "primary"
      ? props.disabled
        ? palette.subtleBgStrong
        : palette.primaryButton
      : palette.subtleBg;
  const iconTintColor = variant === "primary" ? palette.primaryButtonText : palette.icon;
  const textColor = variant === "primary" ? palette.primaryButtonText : palette.text;

  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      className={
        variant === "circle"
          ? "h-11 w-11 items-center justify-center rounded-full"
          : variant === "primary"
            ? "h-11 flex-row items-center justify-center gap-2 rounded-full px-5"
            : "h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5"
      }
      style={{ backgroundColor }}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
      ) : null}
      {props.label ? (
        <Text className="text-center text-[12px] font-t3-bold" style={{ color: textColor }}>
          {props.label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
}) {
  const app = useRemoteApp();
  const flow = useNewTaskFlow();
  const router = useRouter();
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const containerAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom: keyboard.height.value,
  }));
  const controlsBottomPadding = useAnimatedStyle(() => ({
    paddingBottom: keyboard.height.value > 0 ? 4 : Math.max(insets.bottom, 10),
  }));
  const { logicalProjects, selectedProject, setProject } = flow;

  useEffect(() => {
    if (props.initialProjectRef?.environmentId && props.initialProjectRef?.projectId) {
      const directProject =
        app.projects.find(
          (project) =>
            project.environmentId === props.initialProjectRef?.environmentId &&
            project.id === props.initialProjectRef?.projectId,
        ) ?? null;

      if (directProject) {
        setProject(directProject);
        return;
      }
    }

    if (selectedProject) {
      return;
    }

    if (logicalProjects.length === 1) {
      setProject(logicalProjects[0]!.project);
      return;
    }

    router.replace("/new");
  }, [
    app.projects,
    logicalProjects,
    props.initialProjectRef?.environmentId,
    props.initialProjectRef?.projectId,
    router,
    selectedProject,
    setProject,
  ]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    void flow.loadBranches();
  }, [flow, selectedProject]);

  const environmentMenuActions = useMemo(
    () =>
      flow.environments.map((environment) => ({
        id: `environment:${environment.environmentId}`,
        title: environment.environmentLabel,
        state:
          flow.selectedEnvironmentId === environment.environmentId ? ("on" as const) : undefined,
      })),
    [flow.environments, flow.selectedEnvironmentId],
  );

  const modelMenuActions = useMemo(
    () =>
      flow.providerGroups.map((group) => ({
        id: `provider:${group.providerKey}`,
        title: group.providerLabel,
        subtitle: group.models.find(
          (model) =>
            flow.selectedModel &&
            model.selection.provider === flow.selectedModel.provider &&
            model.selection.model === flow.selectedModel.model,
        )?.label,
        subactions: group.models.map((option) => ({
          id: `model:${option.key}`,
          title: option.label,
          state:
            flow.selectedModel &&
            option.selection.provider === flow.selectedModel.provider &&
            option.selection.model === flow.selectedModel.model
              ? ("on" as const)
              : undefined,
        })),
      })),
    [flow.providerGroups, flow.selectedModel],
  );

  const optionsMenuActions = useMemo(
    () => [
      {
        id: "options-effort",
        title: "Effort",
        subtitle: `${flow.effort.charAt(0).toUpperCase()}${flow.effort.slice(1)}`,
        subactions: CLAUDE_CODE_EFFORT_OPTIONS.map((level) => ({
          id: `options:effort:${level}`,
          title: `${level}${level === "high" ? " (default)" : ""}`,
          state: flow.effort === level ? ("on" as const) : undefined,
        })),
      },
      {
        id: "options-fast-mode",
        title: "Fast Mode",
        subtitle: flow.fastMode ? "On" : "Off",
        subactions: ([false, true] as const).map((value) => ({
          id: `options:fast-mode:${value ? "on" : "off"}`,
          title: value ? "On" : "Off",
          state: flow.fastMode === value ? ("on" as const) : undefined,
        })),
      },
      {
        id: "options-context-window",
        title: "Context Window",
        subtitle: flow.contextWindow,
        subactions: (["200k", "1M"] as const).map((value) => ({
          id: `options:context-window:${value}`,
          title: `${value}${value === "1M" ? " (default)" : ""}`,
          state: flow.contextWindow === value ? ("on" as const) : undefined,
        })),
      },
      {
        id: "options-runtime",
        title: "Runtime",
        subtitle:
          flow.runtimeMode === "approval-required"
            ? "Approve actions"
            : flow.runtimeMode === "auto-accept-edits"
              ? "Auto-accept edits"
              : "Full access",
        subactions: [
          { id: "options:runtime:approval-required", title: "Approve actions" },
          { id: "options:runtime:auto-accept-edits", title: "Auto-accept edits" },
          { id: "options:runtime:full-access", title: "Full access" },
        ].map((option) => {
          const value = option.id.replace("options:runtime:", "");
          return {
            id: option.id,
            title: option.title,
            state: flow.runtimeMode === value ? ("on" as const) : undefined,
          };
        }),
      },
      {
        id: "options-interaction",
        title: "Interaction",
        subtitle: flow.interactionMode === "plan" ? "Plan" : "Default",
        subactions: [
          { id: "options:interaction:default", title: "Default" },
          { id: "options:interaction:plan", title: "Plan" },
        ].map((option) => {
          const value = option.id.replace("options:interaction:", "");
          return {
            id: option.id,
            title: option.title,
            state: flow.interactionMode === value ? ("on" as const) : undefined,
          };
        }),
      },
    ],
    [flow.contextWindow, flow.effort, flow.fastMode, flow.interactionMode, flow.runtimeMode],
  );

  const workspaceMenuActions = useMemo(() => {
    const branchActions =
      flow.availableBranches.length === 0
        ? [
            {
              id: "workspace:branch:none",
              title: flow.branchesLoading ? "Loading branches…" : "No branches available",
              attributes: { disabled: true },
            },
          ]
        : flow.availableBranches.slice(0, 12).map((branch) => {
            const badge = branchBadgeLabel({
              branch,
              project: flow.selectedProject,
            });

            return {
              id: `workspace:branch:${branch.name}`,
              title: branch.name,
              subtitle: badge ? badge.toUpperCase() : undefined,
              state: flow.selectedBranchName === branch.name ? ("on" as const) : undefined,
            };
          });

    return [
      {
        id: "workspace:mode",
        title: "Mode",
        subtitle: flow.workspaceMode === "local" ? "Local" : "Worktree",
        subactions: (["local", "worktree"] as const).map((value) => ({
          id: `workspace:mode:${value}`,
          title: value === "local" ? "Local" : "Worktree",
          state: flow.workspaceMode === value ? ("on" as const) : undefined,
        })),
      },
      {
        id: "workspace:branch",
        title: "Branch",
        subtitle: flow.selectedBranchName ?? "Choose branch",
        subactions: branchActions,
      },
    ];
  }, [
    flow.availableBranches,
    flow.branchesLoading,
    flow.selectedBranchName,
    flow.selectedProject,
    flow.workspaceMode,
  ]);

  function handleModelMenuAction(event: string) {
    if (!event.startsWith("model:")) {
      return;
    }
    // Defer state update so the native menu dismiss animation completes
    // before re-rendering the menu actions (prevents submenu jump).
    setTimeout(() => {
      flow.setSelectedModelKey(event.slice("model:".length));
    }, 150);
  }

  function handleEnvironmentMenuAction(event: string) {
    if (!event.startsWith("environment:")) {
      return;
    }
    flow.selectEnvironment(event.slice("environment:".length));
  }

  function handleOptionsMenuAction(event: string) {
    if (event.startsWith("options:effort:")) {
      flow.setEffort(event.slice("options:effort:".length) as typeof flow.effort);
      return;
    }
    if (event.startsWith("options:fast-mode:")) {
      flow.setFastMode(event.endsWith(":on"));
      return;
    }
    if (event.startsWith("options:context-window:")) {
      flow.setContextWindow(event.slice("options:context-window:".length));
      return;
    }
    if (event.startsWith("options:runtime:")) {
      flow.setRuntimeMode(
        event.slice("options:runtime:".length) as Parameters<typeof flow.setRuntimeMode>[0],
      );
      return;
    }
    if (event.startsWith("options:interaction:")) {
      flow.setInteractionMode(
        event.slice("options:interaction:".length) as Parameters<typeof flow.setInteractionMode>[0],
      );
    }
  }

  function handleWorkspaceMenuAction(event: string) {
    if (event.startsWith("workspace:mode:")) {
      flow.setWorkspaceMode(
        event.slice("workspace:mode:".length) as Parameters<typeof flow.setWorkspaceMode>[0],
      );
      return;
    }
    if (event.startsWith("workspace:branch:")) {
      const branchName = event.slice("workspace:branch:".length);
      const branch = flow.availableBranches.find((candidate) => candidate.name === branchName);
      if (branch) {
        flow.selectBranch(branch);
      }
    }
  }

  async function handlePickImages(): Promise<void> {
    const result = await pickComposerImages({ existingCount: flow.attachments.length });
    if (result.images.length > 0) {
      flow.setAttachments((current) => [...current, ...result.images]);
    }
  }

  async function handleNativePaste(payload: PasteEventPayload): Promise<void> {
    console.log("handleNativePaste", payload);
    if (payload.type === "images" && payload.uris && payload.uris.length > 0) {
      try {
        const images = await convertPastedImagesToAttachments({
          uris: payload.uris,
          existingCount: flow.attachments.length,
        });
        console.log("convertPastedImagesToAttachments returned", images.length, "images");
        if (images.length > 0) {
          flow.setAttachments((current) => [...current, ...images]);
        }
      } catch (error) {
        console.error("handleNativePaste error", error);
      }
    }
    // Text paste is handled natively by the TextInput — no action needed
  }

  async function handleStart(): Promise<void> {
    if (
      !flow.selectedProject ||
      !flow.selectedModel ||
      flow.prompt.trim().length === 0 ||
      flow.submitting ||
      (flow.workspaceMode === "worktree" && !flow.selectedBranchName)
    ) {
      return;
    }

    flow.setSubmitting(true);
    try {
      const modelWithOptions: ModelSelection =
        flow.selectedModel.provider === "claudeAgent"
          ? {
              ...flow.selectedModel,
              options: {
                effort: flow.effort,
                fastMode: flow.fastMode || undefined,
                contextWindow: flow.contextWindow,
              },
            }
          : flow.selectedModel.provider === "codex"
            ? { ...flow.selectedModel, options: { fastMode: flow.fastMode || undefined } }
            : flow.selectedModel;

      const createdThread = await app.onCreateThreadWithOptions({
        project: flow.selectedProject,
        modelSelection: modelWithOptions,
        envMode: flow.workspaceMode,
        branch: flow.selectedBranchName,
        worktreePath: flow.workspaceMode === "worktree" ? null : flow.selectedWorktreePath,
        runtimeMode: flow.runtimeMode,
        interactionMode: flow.interactionMode,
        initialMessageText: flow.prompt.trim(),
        initialAttachments: flow.attachments,
      });

      if (createdThread) {
        router.replace(buildThreadRoutePath(createdThread));
      }
    } finally {
      flow.setSubmitting(false);
    }
  }

  if (!selectedProject) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.sheetBackground }}>
        <View style={{ minHeight: 16, paddingTop: 8 }} />
        <View className="items-center gap-1 px-5 pb-3 pt-4">
          <Text
            className="text-[12px] font-t3-bold uppercase"
            style={{ color: palette.textMuted, letterSpacing: 1 }}
          >
            New task
          </Text>
          <Text className="text-[28px] font-t3-bold" style={{ color: palette.text }}>
            Loading task
          </Text>
        </View>
      </View>
    );
  }

  return (
    <Animated.View
      style={[{ flex: 1, backgroundColor: palette.sheetBackground }, containerAnimatedStyle]}
    >
      <View style={{ minHeight: 16, paddingTop: 8 }} />

      <View className="items-center gap-1 px-5 pb-3 pt-4">
        {flow.logicalProjects.length > 1 ? (
          <Pressable
            className="absolute left-3 top-4 h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: palette.subtleBg, zIndex: 1 }}
            onPress={() => router.back()}
          >
            <SymbolView
              name="chevron.left"
              size={16}
              tintColor={palette.icon}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
        ) : null}
        <Text
          className="text-[12px] font-t3-bold uppercase"
          style={{ color: palette.textMuted, letterSpacing: 1 }}
        >
          New task
        </Text>
        <Text className="text-[28px] font-t3-bold" style={{ color: palette.text }}>
          {selectedProject.title}
        </Text>
      </View>

      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 8 }}>
        <TextInputWrapper onPaste={(payload) => void handleNativePaste(payload)}>
          <TextInput
            multiline
            value={flow.prompt}
            onChangeText={flow.setPrompt}
            placeholderTextColor={palette.placeholder}
            placeholder={`Describe a coding task in ${selectedProject.title}`}
            textAlignVertical="top"
            style={{
              flex: 1,
              borderWidth: 0,
              backgroundColor: "transparent",
              color: palette.text,
              fontSize: 18,
              lineHeight: 28,
            }}
          />
        </TextInputWrapper>
      </View>

      <Animated.View
        style={[
          {
            borderTopWidth: 1,
            borderTopColor: palette.border,
          },
          controlsBottomPadding,
        ]}
      >
        {flow.attachments.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, paddingHorizontal: 16, paddingTop: 12 }}
          >
            <View className="flex-row gap-3">
              {flow.attachments.map((attachment: DraftComposerImageAttachment) => (
                <View key={attachment.id} style={{ position: "relative" }}>
                  <Image
                    source={{ uri: attachment.previewUri }}
                    className="h-[88px] w-[88px] rounded-[20px]"
                    resizeMode="cover"
                  />
                  <Pressable
                    className="h-6 w-6 items-center justify-center rounded-full"
                    hitSlop={6}
                    onPress={() =>
                      flow.setAttachments((current) =>
                        current.filter((candidate) => candidate.id !== attachment.id),
                      )
                    }
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      backgroundColor: "rgba(0,0,0,0.55)",
                    }}
                  >
                    <SymbolView
                      name="xmark"
                      size={10}
                      tintColor="#ffffff"
                      type="monochrome"
                      weight="bold"
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : null}
        <View className="flex-row items-center justify-between gap-2 px-4 pb-1 pt-4">
          <ControlPill icon="plus" onPress={() => void handlePickImages()} />
          <MenuView
            actions={modelMenuActions}
            onPressAction={({ nativeEvent }) => handleModelMenuAction(nativeEvent.event)}
          >
            <ControlPill
              iconNode={<ProviderIcon provider={flow.selectedModel?.provider} size={16} />}
            />
          </MenuView>
          <MenuView
            actions={optionsMenuActions}
            onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
          >
            <ControlPill icon="slider.horizontal.3" />
          </MenuView>
          <MenuView
            actions={environmentMenuActions}
            onPressAction={({ nativeEvent }) => handleEnvironmentMenuAction(nativeEvent.event)}
          >
            <ControlPill icon="desktopcomputer" />
          </MenuView>
          <MenuView
            actions={workspaceMenuActions}
            onPressAction={({ nativeEvent }) => handleWorkspaceMenuAction(nativeEvent.event)}
          >
            <ControlPill icon="point.topleft.down.curvedto.point.bottomright.up" />
          </MenuView>
          <ControlPill
            icon="arrow.up"
            label={flow.submitting ? "Starting" : "Start"}
            onPress={() => void handleStart()}
            variant="primary"
            disabled={
              !flow.selectedProject ||
              !flow.selectedModel ||
              flow.prompt.trim().length === 0 ||
              flow.submitting ||
              (flow.workspaceMode === "worktree" && !flow.selectedBranchName)
            }
          />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

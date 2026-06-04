import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { TextInputWrapper } from "expo-paste-input";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  InteractionManager,
  Pressable,
  ScrollView,
  View,
  useColorScheme,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInput as RNTextInput,
} from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { EnvironmentId, type ModelSelection } from "@t3tools/contracts";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";

import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import { buildThreadRoutePath } from "../../lib/routes";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import { useNativePaste } from "../../lib/useNativePaste";
import { CLAUDE_AGENT_EFFORT_OPTIONS } from "./claudeEffortOptions";
import { NewTaskSheetHeader } from "./NewTaskSheetHeader";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { useProjectActions } from "./use-project-actions";

const TOOLBAR_FADE_WIDTH = 18;
const TOOLBAR_SCROLL_EPSILON = 4;

function withModelSelectionOption(
  selection: ModelSelection,
  id: string,
  value: string | boolean | undefined,
): ModelSelection {
  const options = (selection.options ?? []).filter((option) => option.id !== id);
  return {
    ...selection,
    options: value === undefined ? options : [...options, { id, value }],
  };
}

function formatTitleCase(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatWorkspaceLabel(input: {
  readonly workspaceMode: string;
  readonly currentBranchName: string | null;
  readonly selectedBranchName: string | null;
}): string {
  const branchName = input.selectedBranchName ?? input.currentBranchName;
  if (input.workspaceMode === "worktree") {
    return branchName ? `New worktree · ${branchName}` : "New worktree";
  }
  return branchName ? `Current · ${branchName}` : "Current checkout";
}

function NewTaskToolbarTrigger(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly showChevron?: boolean;
}) {
  const iconColor = useThemeColor("--color-icon");

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      onPress={props.onPress}
      className="h-11 flex-row items-center justify-center gap-2 rounded-full bg-subtle px-3.5 active:opacity-70"
      style={{ maxWidth: 172 }}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView name={props.icon} size={16} tintColor={iconColor} type="monochrome" />
      ) : null}
      {props.label ? (
        <Text
          className="shrink text-[13px] font-t3-bold text-foreground"
          ellipsizeMode="tail"
          numberOfLines={1}
        >
          {props.label}
        </Text>
      ) : null}
      {props.showChevron === false ? null : (
        <SymbolView name="chevron.down" size={11} tintColor={iconColor} type="monochrome" />
      )}
    </Pressable>
  );
}

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
}) {
  const { projects } = useRemoteCatalog();
  const { onCreateThreadWithOptions } = useProjectActions();
  const flow = useNewTaskFlow();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const controlsBottomPadding = isKeyboardVisible ? 8 : Math.max(insets.bottom, 10);
  const { logicalProjects, selectedProject, setProject } = flow;
  const promptInputRef = useRef<RNTextInput>(null);
  const [toolbarMetrics, setToolbarMetrics] = useState({
    contentWidth: 0,
    offsetX: 0,
    viewportWidth: 0,
  });

  const borderColor = useThemeColor("--color-border");
  const sheetFadeOpaque = colorScheme === "dark" ? "rgba(14,14,14,0.98)" : "rgba(242,242,247,0.98)";
  const sheetFadeTransparent = colorScheme === "dark" ? "rgba(14,14,14,0)" : "rgba(242,242,247,0)";

  useEffect(() => {
    if (props.initialProjectRef?.environmentId && props.initialProjectRef?.projectId) {
      const directProject =
        projects.find(
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
    logicalProjects,
    projects,
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

  useEffect(() => {
    if (!selectedProject) {
      return;
    }

    let focusFrame: ReturnType<typeof requestAnimationFrame> | null = null;
    const interaction = InteractionManager.runAfterInteractions(() => {
      focusFrame = requestAnimationFrame(() => promptInputRef.current?.focus());
    });

    return () => {
      interaction.cancel();
      if (focusFrame !== null) {
        cancelAnimationFrame(focusFrame);
      }
    };
  }, [selectedProject]);

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
            model.selection.instanceId === flow.selectedModel.instanceId &&
            model.selection.model === flow.selectedModel.model,
        )?.label,
        subactions: group.models.map((option) => ({
          id: `model:${option.key}`,
          title: option.label,
          state:
            flow.selectedModel &&
            option.selection.instanceId === flow.selectedModel.instanceId &&
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
        subactions: CLAUDE_AGENT_EFFORT_OPTIONS.map((level) => ({
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
        subtitle: flow.workspaceMode === "local" ? "Current checkout" : "New worktree",
        subactions: (["local", "worktree"] as const).map((value) => ({
          id: `workspace:mode:${value}`,
          title: value === "local" ? "Current checkout" : "New worktree",
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

  const selectedEnvironmentLabel =
    flow.environments.find(
      (environment) => environment.environmentId === flow.selectedEnvironmentId,
    )?.environmentLabel ?? "Environment";
  const currentBranchName =
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;
  const configurationLabel = useMemo(() => {
    const parts = [
      formatTitleCase(flow.effort),
      flow.fastMode ? "Fast" : null,
      flow.contextWindow !== "1M" ? flow.contextWindow : null,
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" · ") : "Configuration";
  }, [flow.contextWindow, flow.effort, flow.fastMode]);
  const workspaceLabel = useMemo(
    () =>
      formatWorkspaceLabel({
        currentBranchName,
        selectedBranchName: flow.selectedBranchName,
        workspaceMode: flow.workspaceMode,
      }),
    [currentBranchName, flow.selectedBranchName, flow.workspaceMode],
  );
  const toolbarScrollEdges = useMemo(() => {
    const maxOffset = Math.max(0, toolbarMetrics.contentWidth - toolbarMetrics.viewportWidth);
    return {
      showLeftFade: toolbarMetrics.offsetX > TOOLBAR_SCROLL_EPSILON,
      showRightFade: toolbarMetrics.offsetX < maxOffset - TOOLBAR_SCROLL_EPSILON,
    };
  }, [toolbarMetrics]);
  const handleToolbarLayout = useCallback((event: LayoutChangeEvent) => {
    const viewportWidth = event.nativeEvent.layout.width;
    setToolbarMetrics((current) =>
      current.viewportWidth === viewportWidth ? current : { ...current, viewportWidth },
    );
  }, []);
  const handleToolbarContentSizeChange = useCallback((contentWidth: number) => {
    setToolbarMetrics((current) =>
      current.contentWidth === contentWidth ? current : { ...current, contentWidth },
    );
  }, []);
  const handleToolbarScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    setToolbarMetrics((current) =>
      Math.abs(current.offsetX - offsetX) < 1 ? current : { ...current, offsetX },
    );
  }, []);

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
    flow.selectEnvironment(EnvironmentId.make(event.slice("environment:".length)));
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
      flow.appendAttachments(result.images);
    }
  }

  const handleNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: flow.attachments.length,
        });
        if (images.length > 0) {
          flow.appendAttachments(images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", error);
      }
    },
    [flow],
  );

  const handleNativePaste = useNativePaste((uris) => {
    void handleNativePasteImages(uris);
  });

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
        flow.selectedModelOption?.providerDriver === "claudeAgent"
          ? withModelSelectionOption(
              withModelSelectionOption(
                withModelSelectionOption(flow.selectedModel, "effort", flow.effort),
                "fastMode",
                flow.fastMode || undefined,
              ),
              "contextWindow",
              flow.contextWindow,
            )
          : flow.selectedModelOption?.providerDriver === "codex"
            ? withModelSelectionOption(flow.selectedModel, "fastMode", flow.fastMode || undefined)
            : flow.selectedModel;

      const createdThread = await onCreateThreadWithOptions({
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
      <View className="flex-1 bg-sheet">
        <NewTaskSheetHeader title="Loading task" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      <NewTaskSheetHeader
        title={selectedProject.title}
        control={
          flow.logicalProjects.length > 1
            ? { icon: "chevron.left", onPress: () => router.back() }
            : undefined
        }
      />

      <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1 }}>
        <View style={{ flex: 1, minHeight: 0, paddingHorizontal: 20, paddingTop: 8 }}>
          <TextInputWrapper
            onPaste={(payload) => void handleNativePaste(payload)}
            style={{ flex: 1, minHeight: 0 }}
          >
            <TextInput
              ref={promptInputRef}
              autoFocus
              multiline
              scrollEnabled
              value={flow.prompt}
              onChangeText={flow.setPrompt}
              placeholder={`Describe a coding task in ${selectedProject.title}`}
              textAlignVertical="top"
              className="h-full flex-1 border-0 bg-transparent text-[18px] leading-[28px]"
              style={{ flex: 1, minHeight: 0 }}
            />
          </TextInputWrapper>
        </View>

        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: borderColor,
            paddingBottom: controlsBottomPadding,
          }}
        >
          {flow.attachments.length > 0 ? (
            <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
              <ComposerAttachmentStrip
                attachments={flow.attachments}
                onRemove={flow.removeAttachment}
                imageSize={88}
                imageBorderRadius={20}
              />
            </View>
          ) : null}
          <View className="flex-row items-center gap-1.5 px-1.5 pt-2">
            <View className="min-w-0 flex-1" style={{ position: "relative" }}>
              <ScrollView
                horizontal
                keyboardShouldPersistTaps="always"
                onContentSizeChange={handleToolbarContentSizeChange}
                onLayout={handleToolbarLayout}
                onScroll={handleToolbarScroll}
                scrollEventThrottle={16}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{
                  alignItems: "center",
                  gap: 8,
                  paddingLeft: 0,
                  paddingRight: 1,
                }}
              >
                <ControlPill icon="plus" onPress={() => void handlePickImages()} />
                <ControlPillMenu
                  actions={modelMenuActions}
                  onPressAction={({ nativeEvent }) => handleModelMenuAction(nativeEvent.event)}
                >
                  <NewTaskToolbarTrigger
                    accessibilityLabel="Model"
                    iconNode={
                      <ProviderIcon provider={flow.selectedModelOption?.providerDriver} size={16} />
                    }
                    label={flow.selectedModelOption?.label ?? "Model"}
                  />
                </ControlPillMenu>
                <ControlPillMenu
                  actions={optionsMenuActions}
                  onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
                >
                  <NewTaskToolbarTrigger
                    accessibilityLabel="Configuration"
                    icon="slider.horizontal.3"
                    label={configurationLabel}
                  />
                </ControlPillMenu>
                <ControlPillMenu
                  actions={environmentMenuActions}
                  onPressAction={({ nativeEvent }) =>
                    handleEnvironmentMenuAction(nativeEvent.event)
                  }
                >
                  <NewTaskToolbarTrigger
                    accessibilityLabel="Environment"
                    icon="desktopcomputer"
                    label={selectedEnvironmentLabel}
                  />
                </ControlPillMenu>
                <ControlPillMenu
                  actions={workspaceMenuActions}
                  onPressAction={({ nativeEvent }) => handleWorkspaceMenuAction(nativeEvent.event)}
                >
                  <NewTaskToolbarTrigger
                    accessibilityLabel="Workspace"
                    icon="point.topleft.down.curvedto.point.bottomright.up"
                    label={workspaceLabel}
                  />
                </ControlPillMenu>
              </ScrollView>
              {toolbarScrollEdges.showLeftFade ? (
                <View
                  pointerEvents="none"
                  style={{
                    bottom: 0,
                    experimental_backgroundImage: `linear-gradient(to right, ${sheetFadeOpaque} 0%, ${sheetFadeTransparent} 100%)`,
                    left: 0,
                    position: "absolute",
                    top: 0,
                    width: TOOLBAR_FADE_WIDTH,
                  }}
                />
              ) : null}
              {toolbarScrollEdges.showRightFade ? (
                <View
                  pointerEvents="none"
                  style={{
                    bottom: 0,
                    experimental_backgroundImage: `linear-gradient(to right, ${sheetFadeTransparent} 0%, ${sheetFadeOpaque} 100%)`,
                    position: "absolute",
                    right: 0,
                    top: 0,
                    width: TOOLBAR_FADE_WIDTH,
                  }}
                />
              ) : null}
            </View>
            <ControlPill
              accessibilityLabel={flow.submitting ? "Starting task" : "Start task"}
              icon="arrow.up"
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
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

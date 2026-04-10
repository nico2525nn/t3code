import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import type {
  ClaudeCodeEffort,
  GitBranch,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  CLAUDE_CODE_EFFORT_OPTIONS,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
} from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import Reanimated, { SlideInLeft, SlideInRight, SlideOutLeft, SlideOutRight } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { pickComposerImages } from "../../lib/composerImages";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import type { ScopedMobileProject, ScopedMobileThread } from "../../lib/scopedEntities";
import { scopedProjectKey } from "../../lib/scopedEntities";

type WorkspaceMode = "local" | "worktree";

type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly selection: ModelSelection;
};

type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function normalizeSelectedWorktreePath(
  project: ScopedMobileProject,
  branch: GitBranch,
): string | null {
  if (!branch.worktreePath) {
    return null;
  }

  return branch.worktreePath === project.workspaceRoot ? null : branch.worktreePath;
}

function branchBadgeLabel(input: {
  readonly branch: GitBranch;
  readonly project: ScopedMobileProject | null;
}): string | null {
  if (input.branch.current) {
    return "current";
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return "worktree";
  }
  if (input.branch.isDefault) {
    return "default";
  }
  if (input.branch.isRemote) {
    return "remote";
  }
  return null;
}

function providerDisplayLabel(provider: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claudeAgent") return "Claude";
  return provider;
}

function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }

    const pLabel = providerDisplayLabel(provider.provider);
    for (const model of provider.models) {
      const key = `${provider.provider}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: pLabel,
        providerKey: provider.provider,
        providerLabel: pLabel,
        selection: {
          provider: provider.provider,
          model: model.slug,
        },
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.provider}:${fallbackModelSelection.model}`;
    if (!options.has(key)) {
      const pLabel = providerDisplayLabel(fallbackModelSelection.provider);
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: pLabel,
        providerKey: fallbackModelSelection.provider,
        providerLabel: pLabel,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }
  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}

function compactModelLabel(option: ModelOption | null): string {
  if (!option) {
    return "AI";
  }

  const versionMatch = option.selection.model.match(/(\d+(?:\.\d+)?)/);
  if (versionMatch?.[1]) {
    return versionMatch[1];
  }

  const lastToken = option.label.split(/\s+/).at(-1)?.trim();
  return lastToken && lastToken.length <= 6 ? lastToken : "AI";
}

function ControlPill(props: {
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
  readonly label?: string;
  readonly onPress: () => void;
  readonly variant?: "circle" | "pill" | "primary";
  readonly disabled?: boolean;
}) {
  const variant = props.variant ?? "circle";
  const backgroundColor =
    variant === "primary"
      ? props.disabled
        ? "rgba(23,23,23,0.14)"
        : "#171717"
      : "rgba(23,23,23,0.06)";
  const iconTintColor = variant === "primary" ? "#fafaf9" : "#171717";
  const textColor = variant === "primary" ? "#fafaf9" : "#171717";

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
      <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
      {props.label ? (
        <Text className="text-center text-[12px] font-t3-bold" style={{ color: textColor }}>
          {props.label}
        </Text>
      ) : null}
    </Pressable>
  );
}

function BottomSelectorSheet(props: {
  readonly visible: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly snapPoints?: ReadonlyArray<string | number>;
}) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo<(string | number)[]>(
    () => [...(props.snapPoints ?? ["72%"])],
    [props.snapPoints],
  );
  const renderBackdrop = useCallback(
    (backdropProps: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.18}
        pressBehavior="close"
      />
    ),
    [],
  );

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) {
      return;
    }

    if (props.visible) {
      sheet.present();
      return;
    }

    sheet.dismiss();
  }, [props.visible]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      stackBehavior="push"
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={props.onClose}
      backgroundStyle={{ backgroundColor: "rgba(248,246,241,0.98)" }}
      handleIndicatorStyle={{ backgroundColor: "rgba(120,113,108,0.32)" }}
    >
      <BottomSheetView style={{ flex: 1 }} className="px-5 pt-1">
        <View className="items-center pb-4">
          <Text className="text-[24px] font-t3-bold" style={{ color: "#171717" }}>
            {props.title}
          </Text>
        </View>
        {props.children}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

// ---------------------------------------------------------------------------
// Main NewTaskSheet — two-step: project picker → task form
// ---------------------------------------------------------------------------

export function NewTaskSheet(props: {
  readonly visible: boolean;
  readonly projects: ReadonlyArray<ScopedMobileProject>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly serverConfigByEnvironmentId: Readonly<Record<string, T3ServerConfig | null>>;
  readonly onRequestClose: () => void;
  readonly onCreateThreadWithOptions: (input: {
    readonly project: ScopedMobileProject;
    readonly modelSelection: ModelSelection;
    readonly envMode: WorkspaceMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly initialMessageText: string;
    readonly initialAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  }) => Promise<void>;
  readonly onListProjectBranches: (
    project: ScopedMobileProject,
  ) => Promise<ReadonlyArray<GitBranch>>;
}) {
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  // Step state
  const [step, setStep] = useState<"project" | "task">("project");

  // Project picker state
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: props.projects, threads: props.threads }),
    [props.projects, props.threads],
  );
  const logicalProjects = useMemo(
    () =>
      repositoryGroups
        .map((group) => {
          const primaryProject = group.projects[0]?.project;
          if (!primaryProject) return null;
          return { key: group.key, project: primaryProject };
        })
        .filter((entry) => entry !== null),
    [repositoryGroups],
  );

  // Task form state
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    props.projects[0]?.environmentId ?? "",
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("local");
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(null);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerImageAttachment>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [environmentPickerVisible, setEnvironmentPickerVisible] = useState(false);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [optionsPickerVisible, setOptionsPickerVisible] = useState(false);
  const [branchPickerVisible, setBranchPickerVisible] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [availableBranches, setAvailableBranches] = useState<ReadonlyArray<GitBranch>>([]);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [interactionMode, setInteractionMode] =
    useState<ProviderInteractionMode>(DEFAULT_PROVIDER_INTERACTION_MODE);
  const [effort, setEffort] = useState<ClaudeCodeEffort>("high");
  const [fastMode, setFastMode] = useState(false);
  const [contextWindow, setContextWindow] = useState("1M");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const environments = useMemo(
    () =>
      [
        ...new Map(
          props.projects.map((project) => [project.environmentId, project.environmentLabel]),
        ).entries(),
      ].map(([environmentId, environmentLabel]) => ({
        environmentId,
        environmentLabel,
      })),
    [props.projects],
  );

  const projectsForEnvironment = useMemo(
    () => props.projects.filter((project) => project.environmentId === selectedEnvironmentId),
    [props.projects, selectedEnvironmentId],
  );
  const logicalProjectsForEnvironment = useMemo(
    () =>
      groupProjectsByRepository({ projects: projectsForEnvironment, threads: [] })
        .map((group) => group.projects[0]?.project ?? null)
        .filter((project) => project !== null),
    [projectsForEnvironment],
  );

  const selectedProject =
    projectsForEnvironment.find(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    ) ??
    projectsForEnvironment[0] ??
    null;

  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        selectedProject
          ? (props.serverConfigByEnvironmentId[selectedProject.environmentId] ?? null)
          : null,
        selectedProject?.defaultModelSelection ?? null,
      ),
    [props.serverConfigByEnvironmentId, selectedProject],
  );

  const selectedModel =
    modelOptions.find((option) => option.key === selectedModelKey)?.selection ??
    selectedProject?.defaultModelSelection ??
    modelOptions[0]?.selection ??
    null;
  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.provider === selectedModel.provider &&
        option.selection.model === selectedModel.model,
    ) ?? null;

  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    if (query.length === 0) return availableBranches;
    return availableBranches.filter((branch) => branch.name.toLowerCase().includes(query));
  }, [availableBranches, branchQuery]);

  const headerSubtitle = useMemo(() => {
    if (!selectedProject) return null;
    if (workspaceMode === "worktree") {
      return `${selectedProject.title} @ ${selectedBranchName ?? "Select base branch"}`;
    }
    if (selectedBranchName) {
      return `${selectedProject.title} @ ${selectedBranchName}`;
    }
    return `${selectedProject.title} · ${selectedProject.environmentLabel}`;
  }, [selectedBranchName, selectedProject, workspaceMode]);

  const renderBackdrop = useCallback(
    (backdropProps: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.18}
        pressBehavior="close"
      />
    ),
    [],
  );

  // Present / dismiss / reset
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;

    if (props.visible) {
      // Reset state
      setPrompt("");
      setAttachments([]);
      setSelectedModelKey(null);
      setSelectedBranchName(null);
      setSelectedWorktreePath(null);
      setWorkspaceMode("local");
      setRuntimeMode(DEFAULT_RUNTIME_MODE);
      setInteractionMode(DEFAULT_PROVIDER_INTERACTION_MODE);
      setEffort("high");
      setFastMode(false);
      setContextWindow("1M");
      setExpandedProvider(null);
      setSubmitting(false);

      // If only one project, skip to step 2
      if (logicalProjects.length === 1) {
        const only = logicalProjects[0]!;
        setSelectedEnvironmentId(only.project.environmentId);
        setSelectedProjectKey(scopedProjectKey(only.project.environmentId, only.project.id));
        setStep("task");
      } else {
        setStep("project");
      }

      sheet.present();
    } else {
      sheet.dismiss();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  // Step transitions
  const goToTask = useCallback((project: ScopedMobileProject) => {
    setSelectedEnvironmentId(project.environmentId);
    setSelectedProjectKey(scopedProjectKey(project.environmentId, project.id));
    setStep("task");
  }, []);

  const goBackToProjects = useCallback(() => {
    setStep("project");
  }, []);

  // Actions
  async function handlePickImages(): Promise<void> {
    const result = await pickComposerImages({ existingCount: attachments.length });
    if (result.images.length > 0) {
      setAttachments((current) => [...current, ...result.images]);
    }
  }

  async function openBranchPicker(): Promise<void> {
    if (!selectedProject) return;
    setBranchPickerVisible(true);
    setBranchesLoading(true);
    try {
      const branches = await props.onListProjectBranches(selectedProject);
      setAvailableBranches(branches);
      if (workspaceMode === "worktree" && !selectedBranchName) {
        const preferredBranch =
          branches.find((branch) => branch.current)?.name ??
          branches.find((branch) => branch.isDefault)?.name ??
          null;
        if (preferredBranch) setSelectedBranchName(preferredBranch);
      }
    } finally {
      setBranchesLoading(false);
    }
  }

  async function handleStart(): Promise<void> {
    if (
      !selectedProject ||
      !selectedModel ||
      prompt.trim().length === 0 ||
      submitting ||
      (workspaceMode === "worktree" && !selectedBranchName)
    ) {
      return;
    }

    setSubmitting(true);
    try {
      const modelWithOptions: ModelSelection =
        selectedModel.provider === "claudeAgent"
          ? {
              ...selectedModel,
              options: { effort, fastMode: fastMode || undefined, contextWindow },
            }
          : selectedModel.provider === "codex"
            ? { ...selectedModel, options: { fastMode: fastMode || undefined } }
            : selectedModel;

      await props.onCreateThreadWithOptions({
        project: selectedProject,
        modelSelection: modelWithOptions,
        envMode: workspaceMode,
        branch: selectedBranchName,
        worktreePath: workspaceMode === "worktree" ? null : selectedWorktreePath,
        runtimeMode,
        interactionMode,
        initialMessageText: prompt.trim(),
        initialAttachments: attachments,
      });
      props.onRequestClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        stackBehavior="push"
        index={0}
        snapPoints={["92%"]}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={props.onRequestClose}
        backgroundStyle={{ backgroundColor: "rgba(250,248,242,0.98)" }}
        handleIndicatorStyle={{ backgroundColor: "rgba(120,113,108,0.32)" }}
      >
        <BottomSheetView style={{ flex: 1, overflow: "hidden" }}>
          {step === "project" ? (
            <Reanimated.View
              key="step-project"
              entering={SlideInLeft.duration(280)}
              exiting={SlideOutLeft.duration(280)}
              style={{ flex: 1 }}
            >
              <View className="items-center gap-1 px-5 pb-4 pt-1">
                <Text
                  className="text-[12px] font-t3-bold uppercase"
                  style={{ color: "#78716c", letterSpacing: 1 }}
                >
                  New task
                </Text>
                <Text className="text-[28px] font-t3-bold" style={{ color: "#171717" }}>
                  Choose project
                </Text>
              </View>

              <BottomSheetScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{
                  paddingHorizontal: 20,
                  paddingBottom: Math.max(insets.bottom, 18) + 18,
                }}
              >
                <View
                  className="overflow-hidden rounded-[24px]"
                  style={{ backgroundColor: "#ffffff" }}
                >
                  {logicalProjects.map((entry, index) => (
                    <Pressable
                      key={entry.key}
                      onPress={() => goToTask(entry.project)}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 18,
                        borderTopWidth: index === 0 ? 0 : 1,
                        borderTopColor: "rgba(23,23,23,0.06)",
                      }}
                    >
                      <View className="flex-row items-center justify-between gap-3">
                        <View className="flex-1">
                          <Text
                            className="text-[18px] font-t3-bold"
                            style={{ color: "#171717" }}
                          >
                            {entry.project.title}
                          </Text>
                        </View>
                        <SymbolView
                          name="chevron.right"
                          size={14}
                          tintColor="rgba(23,23,23,0.25)"
                          type="monochrome"
                        />
                      </View>
                    </Pressable>
                  ))}
                </View>
              </BottomSheetScrollView>
            </Reanimated.View>
          ) : (
            <Reanimated.View
              key="step-task"
              entering={SlideInRight.duration(280)}
              exiting={SlideOutRight.duration(280)}
              style={{ flex: 1 }}
            >
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : undefined}
              style={{ flex: 1 }}
            >
              <View className="flex-1">
                {/* Header with back button */}
                <View className="items-center gap-1 px-5 pb-3 pt-1">
                  {logicalProjects.length > 1 ? (
                    <Pressable
                      className="absolute left-3 top-1 h-9 w-9 items-center justify-center rounded-full"
                      style={{ backgroundColor: "rgba(23,23,23,0.06)", zIndex: 1 }}
                      onPress={goBackToProjects}
                    >
                      <SymbolView
                        name="chevron.left"
                        size={16}
                        tintColor="#171717"
                        type="monochrome"
                        weight="medium"
                      />
                    </Pressable>
                  ) : null}
                  <Text
                    className="text-[12px] font-t3-bold uppercase"
                    style={{ color: "#78716c", letterSpacing: 1 }}
                  >
                    New task
                  </Text>
                  <Text className="text-[28px] font-t3-bold" style={{ color: "#171717" }}>
                    {selectedProject?.title ?? "New task"}
                  </Text>
                </View>

                <BottomSheetScrollView
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{
                    paddingHorizontal: 20,
                    paddingTop: 8,
                    paddingBottom: 20,
                    minHeight: 420,
                  }}
                >
                  <TextInput
                    multiline
                    value={prompt}
                    onChangeText={setPrompt}
                    placeholderTextColor="#9ca3af"
                    placeholder={
                      selectedProject
                        ? `Describe a coding task in ${selectedProject.title}`
                        : "Describe a coding task"
                    }
                    textAlignVertical="top"
                    className="min-h-[260px] border-0 bg-transparent px-0 py-0 text-[18px] leading-[28px]"
                    style={{
                      borderWidth: 0,
                      backgroundColor: "transparent",
                      color: "#171717",
                      fontSize: 18,
                      lineHeight: 28,
                      minHeight: 280,
                    }}
                  />

                  {attachments.length > 0 ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View className="flex-row gap-3">
                        {attachments.map((attachment) => (
                          <View key={attachment.id} className="gap-2">
                            <Image
                              source={{ uri: attachment.previewUri }}
                              className="h-[88px] w-[88px] rounded-[20px]"
                              resizeMode="cover"
                            />
                            <Pressable
                              className="items-center rounded-full px-3 py-2"
                              style={{ backgroundColor: "rgba(23,23,23,0.06)" }}
                              onPress={() =>
                                setAttachments((current) =>
                                  current.filter((candidate) => candidate.id !== attachment.id),
                                )
                              }
                            >
                              <Text
                                className="text-[12px] font-t3-bold"
                                style={{ color: "#171717" }}
                              >
                                Remove
                              </Text>
                            </Pressable>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  ) : null}
                </BottomSheetScrollView>

                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: "rgba(23,23,23,0.08)",
                    paddingBottom: Math.max(insets.bottom, 10),
                  }}
                >
                  <View className="flex-row items-center justify-between gap-2 px-4 pb-1 pt-4">
                    <ControlPill icon="plus" onPress={() => void handlePickImages()} />
                    <ControlPill
                      icon="dial.low"
                      label={compactModelLabel(selectedModelOption)}
                      onPress={() => setModelPickerVisible(true)}
                      variant="pill"
                    />
                    <ControlPill
                      icon="slider.horizontal.3"
                      onPress={() => setOptionsPickerVisible(true)}
                    />
                    <ControlPill
                      icon="desktopcomputer"
                      onPress={() => setEnvironmentPickerVisible(true)}
                    />
                    <ControlPill
                      icon="point.topleft.down.curvedto.point.bottomright.up"
                      onPress={() => void openBranchPicker()}
                    />
                    <ControlPill
                      icon="arrow.up"
                      label={submitting ? "Starting" : "Start"}
                      onPress={() => void handleStart()}
                      variant="primary"
                      disabled={
                        !selectedProject ||
                        !selectedModel ||
                        prompt.trim().length === 0 ||
                        submitting ||
                        (workspaceMode === "worktree" && !selectedBranchName)
                      }
                    />
                  </View>
                </View>
              </View>
            </KeyboardAvoidingView>
            </Reanimated.View>
          )}
        </BottomSheetView>
      </BottomSheetModal>

      {/* Sub-pickers (environment, project, model, branch) */}
      <BottomSelectorSheet
        visible={environmentPickerVisible}
        title="Environment"
        onClose={() => setEnvironmentPickerVisible(false)}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <View className="overflow-hidden rounded-[24px]" style={{ backgroundColor: "#ffffff" }}>
            {environments.map((environment, index) => (
              <Pressable
                key={environment.environmentId}
                onPress={() => {
                  setSelectedEnvironmentId(environment.environmentId);
                  setSelectedProjectKey(null);
                  setSelectedBranchName(null);
                  setSelectedWorktreePath(null);
                  setEnvironmentPickerVisible(false);
                }}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 18,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: "rgba(23,23,23,0.06)",
                }}
              >
                <Text className="text-[17px] font-medium" style={{ color: "#171717" }}>
                  {environment.environmentLabel}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </BottomSelectorSheet>

      <BottomSelectorSheet
        visible={projectPickerVisible}
        title="Project"
        onClose={() => setProjectPickerVisible(false)}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <View className="overflow-hidden rounded-[24px]" style={{ backgroundColor: "#ffffff" }}>
            {logicalProjectsForEnvironment.map((project, index) => (
              <Pressable
                key={`${project.environmentId}:${project.id}`}
                onPress={() => {
                  setSelectedProjectKey(scopedProjectKey(project.environmentId, project.id));
                  setSelectedBranchName(null);
                  setSelectedWorktreePath(null);
                  setProjectPickerVisible(false);
                }}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 18,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: "rgba(23,23,23,0.06)",
                }}
              >
                <Text className="text-[17px] font-medium" style={{ color: "#171717" }}>
                  {project.title}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </BottomSelectorSheet>

      {/* Model picker — provider + model only */}
      <BottomSelectorSheet
        visible={modelPickerVisible}
        title="Model"
        onClose={() => {
          setModelPickerVisible(false);
          setExpandedProvider(null);
        }}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <View className="gap-2">
            {providerGroups.map((group) => {
              const isExpanded = expandedProvider === group.providerKey;
              const hasSelected = group.models.some(
                (m) =>
                  selectedModel &&
                  m.selection.provider === selectedModel.provider &&
                  m.selection.model === selectedModel.model,
              );

              return (
                <View key={group.providerKey}>
                  <Pressable
                    onPress={() =>
                      setExpandedProvider(isExpanded ? null : group.providerKey)
                    }
                    className="flex-row items-center justify-between rounded-[16px] px-4 py-3.5"
                    style={{
                      backgroundColor: isExpanded
                        ? "rgba(23,23,23,0.06)"
                        : hasSelected
                          ? "rgba(23,23,23,0.04)"
                          : "#ffffff",
                      borderWidth: hasSelected && !isExpanded ? 1 : 0,
                      borderColor: "rgba(23,23,23,0.08)",
                    }}
                  >
                    <View className="flex-row items-center gap-2.5">
                      <Text className="text-[17px] font-t3-bold" style={{ color: "#171717" }}>
                        {group.providerLabel}
                      </Text>
                      {hasSelected && !isExpanded ? (
                        <Text className="text-[13px]" style={{ color: "#78716c" }}>
                          {selectedModelOption?.label}
                        </Text>
                      ) : null}
                    </View>
                    <SymbolView
                      name={isExpanded ? "chevron.up" : "chevron.right"}
                      size={14}
                      tintColor="rgba(23,23,23,0.25)"
                      type="monochrome"
                    />
                  </Pressable>

                  {isExpanded ? (
                    <View
                      className="mt-1.5 overflow-hidden rounded-[14px]"
                      style={{ backgroundColor: "#ffffff" }}
                    >
                      {group.models.map((option, index) => {
                        const isSelected =
                          selectedModel &&
                          option.selection.provider === selectedModel.provider &&
                          option.selection.model === selectedModel.model;
                        return (
                          <Pressable
                            key={option.key}
                            onPress={() => {
                              setSelectedModelKey(option.key);
                              setModelPickerVisible(false);
                              setExpandedProvider(null);
                            }}
                            style={{
                              paddingHorizontal: 16,
                              paddingVertical: 14,
                              borderTopWidth: index === 0 ? 0 : 1,
                              borderTopColor: "rgba(23,23,23,0.06)",
                              backgroundColor: isSelected ? "rgba(23,23,23,0.04)" : "transparent",
                            }}
                          >
                            <View className="flex-row items-center justify-between">
                              <Text className="text-[16px] font-medium" style={{ color: "#171717" }}>
                                {option.label}
                              </Text>
                              {isSelected ? (
                                <SymbolView name="checkmark" size={16} tintColor="#2563eb" type="monochrome" />
                              ) : null}
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </ScrollView>
      </BottomSelectorSheet>

      {/* Options picker — effort, fast mode, context window, mode, access */}
      <BottomSelectorSheet
        visible={optionsPickerVisible}
        title="Options"
        onClose={() => setOptionsPickerVisible(false)}
        snapPoints={["82%"]}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <View className="gap-5 pb-4">
            {/* ── Effort ── */}
            <View className="gap-2">
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: "#78716c", letterSpacing: 0.8 }}
              >
                Effort
              </Text>
              <View className="overflow-hidden rounded-[14px]" style={{ backgroundColor: "#ffffff" }}>
                {CLAUDE_CODE_EFFORT_OPTIONS.map((level, index) => (
                  <Pressable
                    key={level}
                    onPress={() => setEffort(level)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 13,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: "rgba(23,23,23,0.06)",
                    }}
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="text-[15px] font-medium capitalize" style={{ color: "#171717" }}>
                        {level}{level === "high" ? " (default)" : ""}
                      </Text>
                      {effort === level ? (
                        <SymbolView name="checkmark" size={15} tintColor="#2563eb" type="monochrome" />
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* ── Fast Mode ── */}
            <View className="gap-2">
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: "#78716c", letterSpacing: 0.8 }}
              >
                Fast Mode
              </Text>
              <View className="overflow-hidden rounded-[14px]" style={{ backgroundColor: "#ffffff" }}>
                {([false, true] as const).map((value, index) => (
                  <Pressable
                    key={String(value)}
                    onPress={() => setFastMode(value)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 13,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: "rgba(23,23,23,0.06)",
                    }}
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="text-[15px] font-medium" style={{ color: "#171717" }}>
                        {value ? "On" : "Off"}
                      </Text>
                      {fastMode === value ? (
                        <SymbolView name="checkmark" size={15} tintColor="#2563eb" type="monochrome" />
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* ── Context Window ── */}
            <View className="gap-2">
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: "#78716c", letterSpacing: 0.8 }}
              >
                Context Window
              </Text>
              <View className="overflow-hidden rounded-[14px]" style={{ backgroundColor: "#ffffff" }}>
                {(["200k", "1M"] as const).map((value, index) => (
                  <Pressable
                    key={value}
                    onPress={() => setContextWindow(value)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 13,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: "rgba(23,23,23,0.06)",
                    }}
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="text-[15px] font-medium" style={{ color: "#171717" }}>
                        {value}{value === "1M" ? " (default)" : ""}
                      </Text>
                      {contextWindow === value ? (
                        <SymbolView name="checkmark" size={15} tintColor="#2563eb" type="monochrome" />
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* ── Mode ── */}
            <View className="gap-2">
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: "#78716c", letterSpacing: 0.8 }}
              >
                Mode
              </Text>
              <View className="overflow-hidden rounded-[14px]" style={{ backgroundColor: "#ffffff" }}>
                {(
                  [
                    { value: "default" as const, label: "Chat" },
                    { value: "plan" as const, label: "Plan" },
                  ] as const
                ).map((option, index) => (
                  <Pressable
                    key={option.value}
                    onPress={() => setInteractionMode(option.value)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 13,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: "rgba(23,23,23,0.06)",
                    }}
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="text-[15px] font-medium" style={{ color: "#171717" }}>
                        {option.label}
                      </Text>
                      {interactionMode === option.value ? (
                        <SymbolView name="checkmark" size={15} tintColor="#2563eb" type="monochrome" />
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* ── Access ── */}
            <View className="gap-2">
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: "#78716c", letterSpacing: 0.8 }}
              >
                Access
              </Text>
              <View className="overflow-hidden rounded-[14px]" style={{ backgroundColor: "#ffffff" }}>
                {(
                  [
                    { value: "approval-required" as const, label: "Supervised", desc: "Ask before commands and file changes" },
                    { value: "auto-accept-edits" as const, label: "Auto-accept edits", desc: "Auto-approve edits, ask before other actions" },
                    { value: "full-access" as const, label: "Full access", desc: "Allow commands and edits without prompts" },
                  ] as const
                ).map((option, index) => (
                  <Pressable
                    key={option.value}
                    onPress={() => setRuntimeMode(option.value)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 13,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: "rgba(23,23,23,0.06)",
                    }}
                  >
                    <View className="flex-row items-center justify-between gap-3">
                      <View className="flex-1 gap-0.5">
                        <Text className="text-[15px] font-medium" style={{ color: "#171717" }}>
                          {option.label}
                        </Text>
                        <Text className="text-[12px]" style={{ color: "#78716c" }}>
                          {option.desc}
                        </Text>
                      </View>
                      {runtimeMode === option.value ? (
                        <SymbolView name="checkmark" size={15} tintColor="#2563eb" type="monochrome" />
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        </ScrollView>
      </BottomSelectorSheet>

      <BottomSelectorSheet
        visible={branchPickerVisible}
        title="Workspace"
        onClose={() => setBranchPickerVisible(false)}
      >
        <View className="gap-4">
          <View className="flex-row gap-2">
            <Pressable
              onPress={() => setWorkspaceMode("local")}
              className="flex-1 rounded-full px-4 py-3"
              style={{
                backgroundColor:
                  workspaceMode === "local" ? "rgba(23,23,23,0.08)" : "rgba(23,23,23,0.04)",
              }}
            >
              <Text className="text-center text-[14px] font-t3-bold" style={{ color: "#171717" }}>
                Current checkout
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setWorkspaceMode("worktree");
                setSelectedWorktreePath(null);
              }}
              className="flex-1 rounded-full px-4 py-3"
              style={{
                backgroundColor:
                  workspaceMode === "worktree" ? "rgba(23,23,23,0.08)" : "rgba(23,23,23,0.04)",
              }}
            >
              <Text className="text-center text-[14px] font-t3-bold" style={{ color: "#171717" }}>
                New worktree
              </Text>
            </Pressable>
          </View>

          <TextInput
            value={branchQuery}
            onChangeText={setBranchQuery}
            placeholder="Search branches"
            className="bg-white"
          />

          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="overflow-hidden rounded-[24px]" style={{ backgroundColor: "#ffffff" }}>
              {branchesLoading ? (
                <View className="px-4 py-5">
                  <Text className="text-[15px] font-medium" style={{ color: "#78716c" }}>
                    Loading branches...
                  </Text>
                </View>
              ) : (
                filteredBranches.map((branch, index) => {
                  const normalizedWorktreePath = selectedProject
                    ? normalizeSelectedWorktreePath(selectedProject, branch)
                    : null;
                  const selected =
                    selectedBranchName === branch.name &&
                    (workspaceMode === "worktree"
                      ? selectedWorktreePath === null
                      : (selectedWorktreePath ?? null) === normalizedWorktreePath);
                  const badge = branchBadgeLabel({ branch, project: selectedProject });

                  return (
                    <Pressable
                      key={branch.name}
                      onPress={() => {
                        setSelectedBranchName(branch.name);
                        setSelectedWorktreePath(
                          workspaceMode === "worktree" ? null : normalizedWorktreePath,
                        );
                        setBranchPickerVisible(false);
                      }}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 18,
                        borderTopWidth: index === 0 ? 0 : 1,
                        borderTopColor: "rgba(23,23,23,0.06)",
                      }}
                    >
                      <View className="flex-row items-center justify-between gap-3">
                        <View className="flex-1 gap-1">
                          <Text className="text-[17px] font-medium" style={{ color: "#171717" }}>
                            {branch.name}
                          </Text>
                          <Text className="text-[13px] font-medium" style={{ color: "#78716c" }}>
                            {workspaceMode === "worktree"
                              ? "Base branch for new worktree"
                              : normalizedWorktreePath
                                ? "Existing worktree"
                                : "Current checkout"}
                          </Text>
                        </View>
                        <View className="items-end gap-1">
                          {badge ? (
                            <Text
                              className="text-[11px] font-medium"
                              style={{ color: "rgba(23,23,23,0.35)" }}
                            >
                              {badge}
                            </Text>
                          ) : null}
                          {selected ? (
                            <SymbolView
                              name="checkmark"
                              size={18}
                              tintColor="#2563eb"
                              type="monochrome"
                            />
                          ) : null}
                        </View>
                      </View>
                    </Pressable>
                  );
                })
              )}
            </View>
          </ScrollView>
        </View>
      </BottomSelectorSheet>
    </>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ClaudeCodeEffort,
  GitBranch,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";

import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import type { ScopedMobileProject } from "../../lib/scopedEntities";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useRemoteApp } from "../../state/remote-app-state-provider";

export type WorkspaceMode = "local" | "worktree";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

export function normalizeSelectedWorktreePath(
  project: ScopedMobileProject,
  branch: GitBranch,
): string | null {
  if (!branch.worktreePath) {
    return null;
  }

  return branch.worktreePath === project.workspaceRoot ? null : branch.worktreePath;
}

export function branchBadgeLabel(input: {
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

    const providerLabel = providerDisplayLabel(provider.provider);
    for (const model of provider.models) {
      const key = `${provider.provider}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.provider,
        providerLabel,
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
      const providerLabel = providerDisplayLabel(fallbackModelSelection.provider);
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.provider,
        providerLabel,
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

type NewTaskFlowContextValue = {
  readonly logicalProjects: ReadonlyArray<{
    readonly key: string;
    readonly project: ScopedMobileProject;
  }>;
  readonly selectedEnvironmentId: string;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly workspaceMode: WorkspaceMode;
  readonly selectedBranchName: string | null;
  readonly selectedWorktreePath: string | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly submitting: boolean;
  readonly branchQuery: string;
  readonly branchesLoading: boolean;
  readonly availableBranches: ReadonlyArray<GitBranch>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly effort: ClaudeCodeEffort;
  readonly fastMode: boolean;
  readonly contextWindow: string;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly environmentLabel: string;
  }>;
  readonly selectedProject: ScopedMobileProject | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly filteredBranches: ReadonlyArray<GitBranch>;
  readonly reset: () => void;
  readonly setProject: (project: ScopedMobileProject) => void;
  readonly selectEnvironment: (environmentId: string) => void;
  readonly setSelectedModelKey: (key: string | null) => void;
  readonly setWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly selectBranch: (branch: GitBranch) => void;
  readonly setPrompt: (value: string) => void;
  readonly setAttachments: React.Dispatch<
    React.SetStateAction<ReadonlyArray<DraftComposerImageAttachment>>
  >;
  readonly setSubmitting: (value: boolean) => void;
  readonly setBranchQuery: (value: string) => void;
  readonly loadBranches: () => Promise<void>;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setInteractionMode: (value: ProviderInteractionMode) => void;
  readonly setEffort: (value: ClaudeCodeEffort) => void;
  readonly setFastMode: (value: boolean) => void;
  readonly setContextWindow: (value: string) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(props: React.PropsWithChildren) {
  const app = useRemoteApp();

  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: app.projects, threads: app.threads }),
    [app.projects, app.threads],
  );
  const logicalProjects = useMemo(
    () =>
      repositoryGroups
        .map((group) => {
          const primaryProject = group.projects[0]?.project;
          if (!primaryProject) {
            return null;
          }
          return { key: group.key, project: primaryProject };
        })
        .filter((entry) => entry !== null),
    [repositoryGroups],
  );

  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    app.projects[0]?.environmentId ?? "",
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("local");
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(null);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerImageAttachment>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [availableBranches, setAvailableBranches] = useState<ReadonlyArray<GitBranch>>([]);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    DEFAULT_PROVIDER_INTERACTION_MODE,
  );
  const [effort, setEffort] = useState<ClaudeCodeEffort>("high");
  const [fastMode, setFastMode] = useState(false);
  const [contextWindow, setContextWindow] = useState("1M");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const reset = useCallback(() => {
    console.log("[new task flow] reset", {
      defaultEnvironmentId: app.projects[0]?.environmentId ?? null,
      projectCount: app.projects.length,
    });
    setSelectedEnvironmentId(app.projects[0]?.environmentId ?? "");
    setSelectedProjectKey(null);
    setSelectedModelKey(null);
    setWorkspaceMode("local");
    setSelectedBranchName(null);
    setSelectedWorktreePath(null);
    setPrompt("");
    setAttachments([]);
    setSubmitting(false);
    setBranchQuery("");
    setBranchesLoading(false);
    setAvailableBranches([]);
    setRuntimeMode(DEFAULT_RUNTIME_MODE);
    setInteractionMode(DEFAULT_PROVIDER_INTERACTION_MODE);
    setEffort("high");
    setFastMode(false);
    setContextWindow("1M");
    setExpandedProvider(null);
  }, [app.projects]);

  useEffect(() => {
    if (selectedEnvironmentId || app.projects.length === 0) {
      return;
    }

    console.log("[new task flow] initializing environment", {
      environmentId: app.projects[0]!.environmentId,
    });
    setSelectedEnvironmentId(app.projects[0]!.environmentId);
  }, [app.projects, selectedEnvironmentId]);

  const environments = useMemo(
    () =>
      [
        ...new Map(
          app.projects.map((project) => [project.environmentId, project.environmentLabel]),
        ).entries(),
      ].map(([environmentId, environmentLabel]) => ({
        environmentId,
        environmentLabel,
      })),
    [app.projects],
  );

  const projectsForEnvironment = useMemo(
    () => app.projects.filter((project) => project.environmentId === selectedEnvironmentId),
    [app.projects, selectedEnvironmentId],
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
          ? (app.serverConfigByEnvironmentId[selectedProject.environmentId] ?? null)
          : null,
        selectedProject?.defaultModelSelection ?? null,
      ),
    [app.serverConfigByEnvironmentId, selectedProject],
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
    if (query.length === 0) {
      return availableBranches;
    }

    return availableBranches.filter((branch) => branch.name.toLowerCase().includes(query));
  }, [availableBranches, branchQuery]);

  const setProject = useCallback((project: ScopedMobileProject) => {
    setSelectedEnvironmentId(project.environmentId);
    setSelectedProjectKey(scopedProjectKey(project.environmentId, project.id));
  }, []);

  const selectEnvironment = useCallback((environmentId: string) => {
    setSelectedEnvironmentId(environmentId);
    setSelectedProjectKey(null);
    setSelectedBranchName(null);
    setSelectedWorktreePath(null);
  }, []);

  const selectBranch = useCallback(
    (branch: GitBranch) => {
      setSelectedBranchName(branch.name);
      setSelectedWorktreePath(
        selectedProject ? normalizeSelectedWorktreePath(selectedProject, branch) : null,
      );
    },
    [selectedProject],
  );

  const loadBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setBranchesLoading(true);
    try {
      const branches = await app.onListProjectBranches(selectedProject);
      setAvailableBranches(branches);

      if (workspaceMode === "worktree" && !selectedBranchName) {
        const preferredBranch =
          branches.find((branch) => branch.current)?.name ??
          branches.find((branch) => branch.isDefault)?.name ??
          null;
        if (preferredBranch) {
          setSelectedBranchName(preferredBranch);
        }
      }
    } finally {
      setBranchesLoading(false);
    }
  }, [app, selectedBranchName, selectedProject, workspaceMode]);

  const value = useMemo<NewTaskFlowContextValue>(
    () => ({
      logicalProjects,
      selectedEnvironmentId,
      selectedProjectKey,
      selectedModelKey,
      workspaceMode,
      selectedBranchName,
      selectedWorktreePath,
      prompt,
      attachments,
      submitting,
      branchQuery,
      branchesLoading,
      availableBranches,
      runtimeMode,
      interactionMode,
      effort,
      fastMode,
      contextWindow,
      expandedProvider,
      environments,
      selectedProject,
      modelOptions,
      selectedModel,
      selectedModelOption,
      providerGroups,
      filteredBranches,
      reset,
      setProject,
      selectEnvironment,
      setSelectedModelKey,
      setWorkspaceMode,
      selectBranch,
      setPrompt,
      setAttachments,
      setSubmitting,
      setBranchQuery,
      loadBranches,
      setRuntimeMode,
      setInteractionMode,
      setEffort,
      setFastMode,
      setContextWindow,
      setExpandedProvider,
    }),
    [
      attachments,
      availableBranches,
      branchQuery,
      branchesLoading,
      contextWindow,
      effort,
      environments,
      expandedProvider,
      fastMode,
      filteredBranches,
      interactionMode,
      loadBranches,
      logicalProjects,
      modelOptions,
      prompt,
      providerGroups,
      reset,
      runtimeMode,
      selectedBranchName,
      selectedEnvironmentId,
      selectedModel,
      selectedModelKey,
      selectedModelOption,
      selectedProject,
      selectedProjectKey,
      selectedWorktreePath,
      setProject,
      selectBranch,
      selectEnvironment,
      submitting,
      workspaceMode,
    ],
  );

  useEffect(() => {
    console.log("[new task flow] state", {
      availableBranchCount: availableBranches.length,
      environmentCount: environments.length,
      logicalProjectCount: logicalProjects.length,
      selectedEnvironmentId,
      selectedProjectKey,
      selectedProjectTitle: selectedProject?.title ?? null,
    });
  }, [
    availableBranches.length,
    environments.length,
    logicalProjects.length,
    selectedEnvironmentId,
    selectedProject?.title,
    selectedProjectKey,
  ]);

  return <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>;
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}

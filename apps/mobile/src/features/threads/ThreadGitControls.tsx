import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { MenuView } from "@react-native-menu/menu";
import type { GitBranch, GitRunStackedActionResult, GitStatusResult } from "@t3tools/contracts";
import {
  buildMenuItems,
  getGitActionDisabledReason,
  type GitActionRequestInput,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
} from "@t3tools/client-runtime";
import { resolveAutoFeatureBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { SymbolView } from "expo-symbols";
import type { ComponentProps, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Pressable, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { makeAppPalette } from "../../lib/theme";

type PendingDefaultBranchAction = {
  readonly action: Extract<
    GitActionRequestInput["action"],
    "push" | "create_pr" | "commit_push" | "commit_push_pr"
  >;
  readonly branchName: string;
  readonly includesCommit: boolean;
  readonly commitMessage?: string;
  readonly filePaths?: readonly string[];
};

function useSheetVisibility(sheetRef: RefObject<BottomSheetModal | null>, visible: boolean) {
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) {
      return;
    }

    if (visible) {
      sheet.present();
      return;
    }

    sheet.dismiss();
  }, [sheetRef, visible]);
}

function statusSummary(gitStatus: GitStatusResult | null): string {
  if (!gitStatus) {
    return "Loading branch status…";
  }

  if (!gitStatus.isRepo) {
    return "Not a git repository";
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(
      `${gitStatus.workingTree.files.length} file${gitStatus.workingTree.files.length === 1 ? "" : "s"} changed`,
    );
  } else {
    parts.push("Clean");
  }
  if (gitStatus.aheadCount > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  }
  if (gitStatus.behindCount > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  }
  if (gitStatus.pr?.state === "open") {
    parts.push(`PR #${gitStatus.pr.number} open`);
  }

  return parts.join(" · ");
}

function deriveAvailableBranchLabel(
  currentBranch: string | null,
  gitStatus: GitStatusResult | null,
): string {
  return gitStatus?.branch ?? currentBranch ?? "Detached HEAD";
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

function compactMenuBranchLabel(branch: string): string {
  return truncateMiddle(branch, 24);
}

function compactMenuStatus(gitStatus: GitStatusResult | null): string {
  if (!gitStatus) {
    return "Checking status";
  }
  if (!gitStatus.isRepo) {
    return "Not a repo";
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(`${gitStatus.workingTree.files.length} changed`);
  } else if (gitStatus.aheadCount === 0 && gitStatus.behindCount === 0) {
    parts.push("Clean");
  }
  if (gitStatus.aheadCount > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  }
  if (gitStatus.behindCount > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  }
  if (gitStatus.pr?.state === "open") {
    parts.push(`PR #${gitStatus.pr.number}`);
  }

  return parts.join(" · ");
}

function triggerStatusLabel(
  gitStatus: GitStatusResult | null,
  gitOperationLabel: string | null,
): string {
  if (gitOperationLabel) {
    return "Working";
  }
  if (!gitStatus) {
    return "Checking";
  }
  if (!gitStatus.isRepo) {
    return "No repo";
  }
  if (gitStatus.hasWorkingTreeChanges) {
    return `${gitStatus.workingTree.files.length} changed`;
  }
  if (gitStatus.behindCount > 0) {
    return `${gitStatus.behindCount} behind`;
  }
  if (gitStatus.aheadCount > 0) {
    return `${gitStatus.aheadCount} ahead`;
  }
  if (gitStatus.pr?.state === "open") {
    return "PR open";
  }
  return "Clean";
}

function menuItemIconName(
  icon: "commit" | "push" | "pr",
): ComponentProps<typeof SymbolView>["name"] {
  if (icon === "commit") return "checkmark.circle";
  if (icon === "push") return "arrow.up.circle";
  return "arrow.up.right.circle";
}

function SheetActionButton(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly onPress: () => void;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const tone = props.tone ?? "secondary";
  const colors =
    tone === "primary"
      ? {
          backgroundColor: palette.primaryButton,
          borderColor: "transparent",
          textColor: palette.primaryButtonText,
        }
      : tone === "danger"
        ? {
            backgroundColor: palette.dangerButton,
            borderColor: palette.dangerBorder,
            textColor: palette.dangerText,
          }
        : {
            backgroundColor: palette.secondaryButton,
            borderColor: palette.secondaryButtonBorder,
            textColor: palette.secondaryButtonText,
          };

  return (
    <Pressable
      className="min-h-[48px] flex-1 flex-row items-center justify-center gap-2 rounded-[18px] px-4 py-3"
      disabled={props.disabled}
      style={{
        backgroundColor: colors.backgroundColor,
        borderWidth: tone === "primary" ? 0 : 1,
        borderColor: colors.borderColor,
        opacity: props.disabled ? 0.45 : 1,
      }}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={16} tintColor={colors.textColor} type="monochrome" />
      <Text
        className="text-[12px] font-t3-bold uppercase"
        style={{ color: colors.textColor, letterSpacing: 0.9 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function MetaCard(props: { readonly label: string; readonly value: string }) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  return (
    <View
      className="rounded-[18px] border px-4 py-3"
      style={{ backgroundColor: palette.card, borderColor: palette.border }}
    >
      <Text
        className="text-[11px] font-t3-bold uppercase"
        style={{ color: palette.textMuted, letterSpacing: 0.9 }}
      >
        {props.label}
      </Text>
      <Text
        selectable
        className="text-[13px] font-medium"
        numberOfLines={1}
        style={{ color: palette.text }}
      >
        {props.value}
      </Text>
    </View>
  );
}

function SheetListRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly title: string;
  readonly subtitle?: string | null;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  return (
    <Pressable
      className="flex-row items-center gap-3 px-1 py-3"
      disabled={props.disabled}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
      onPress={props.onPress}
    >
      <View
        className="h-9 w-9 items-center justify-center rounded-full"
        style={{ backgroundColor: palette.subtleBg }}
      >
        <SymbolView name={props.icon} size={16} tintColor={palette.icon} type="monochrome" />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-[16px] font-t3-bold" style={{ color: palette.text }}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-[12px] leading-[17px]" style={{ color: palette.textMuted }}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      <SymbolView name="chevron.right" size={13} tintColor={palette.iconSubtle} type="monochrome" />
    </Pressable>
  );
}

export function ThreadGitControls(props: {
  readonly currentBranch: string | null;
  readonly currentWorktreePath: string | null;
  readonly gitStatus: GitStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly onRefreshStatus: (options?: { readonly quiet?: boolean }) => Promise<void>;
  readonly onListBranches: () => Promise<ReadonlyArray<GitBranch>>;
  readonly onCheckoutBranch: (branch: string) => Promise<void>;
  readonly onCreateBranch: (branch: string) => Promise<void>;
  readonly onCreateWorktree: (input: {
    readonly baseBranch: string;
    readonly newBranch: string;
  }) => Promise<void>;
  readonly onPull: () => Promise<void>;
  readonly onRunAction: (input: GitActionRequestInput) => Promise<GitRunStackedActionResult | null>;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makeAppPalette(isDarkMode);
  const insets = useSafeAreaInsets();
  const {
    currentWorktreePath,
    gitOperationLabel,
    gitStatus,
    onCheckoutBranch,
    onCreateBranch,
    onCreateWorktree,
    onListBranches,
    onPull,
    onRefreshStatus,
    onRunAction,
  } = props;
  const gitSheetRef = useRef<BottomSheetModal>(null);
  const branchSheetRef = useRef<BottomSheetModal>(null);
  const commitSheetRef = useRef<BottomSheetModal>(null);
  const defaultBranchSheetRef = useRef<BottomSheetModal>(null);
  const [gitSheetVisible, setGitSheetVisible] = useState(false);
  const [branchSheetVisible, setBranchSheetVisible] = useState(false);
  const [commitSheetVisible, setCommitSheetVisible] = useState(false);
  const [defaultBranchSheetVisible, setDefaultBranchSheetVisible] = useState(false);
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [availableBranches, setAvailableBranches] = useState<ReadonlyArray<GitBranch>>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranch, setWorktreeBaseBranch] = useState("");
  const [worktreeBranchName, setWorktreeBranchName] = useState("");
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const currentBranchLabel = deriveAvailableBranchLabel(props.currentBranch, gitStatus);
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasOriginRemote = gitStatus?.hasOriginRemote ?? false;
  const isDefaultBranch = gitStatus?.isDefaultBranch ?? false;
  const quickAction = useMemo(
    () =>
      isRepo
        ? resolveQuickAction(gitStatus, busy, isDefaultBranch, hasOriginRemote)
        : {
            label: "Git unavailable",
            disabled: true,
            kind: "show_hint" as const,
            hint: "This workspace is not a git repository.",
          },
    [busy, gitStatus, hasOriginRemote, isDefaultBranch, isRepo],
  );
  const menuItems = useMemo(
    () => (isRepo ? buildMenuItems(gitStatus, busy, hasOriginRemote) : []),
    [busy, gitStatus, hasOriginRemote, isRepo],
  );
  const quickActionHint = quickAction.disabled
    ? (quickAction.hint ?? "This action is unavailable.")
    : null;
  const triggerStatus = triggerStatusLabel(gitStatus, gitOperationLabel);
  const allFiles = gitStatus?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;
  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);
  const selectedFilePreview = selectedFiles.slice(0, 3);
  const renderBackdrop = useCallback(
    (backdropProps: ComponentProps<typeof BottomSheetBackdrop>) => (
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
  const gitSnapPoints = useMemo<(string | number)[]>(() => ["72%"], []);
  const branchSnapPoints = useMemo<(string | number)[]>(() => ["86%"], []);
  const commitSnapPoints = useMemo<(string | number)[]>(() => ["88%"], []);
  const defaultBranchSnapPoints = useMemo<(string | number)[]>(() => ["40%"], []);
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;
  const disabledExistingBranches = useMemo(
    () =>
      new Set(
        availableBranches
          .filter(
            (branch) => branch.worktreePath !== null && branch.worktreePath !== currentWorktreePath,
          )
          .map((branch) => branch.name),
      ),
    [availableBranches, currentWorktreePath],
  );
  const sheetMenuItems = useMemo(
    () =>
      menuItems.map((item) => ({
        item,
        disabledReason: getGitActionDisabledReason({
          item,
          gitStatus,
          isBusy: busy,
          hasOriginRemote,
        }),
      })),
    [busy, gitStatus, hasOriginRemote, menuItems],
  );
  const nativeMenuActions = useMemo<
    Array<{
      id: string;
      title: string;
      subtitle?: string;
      state?: "off";
      image?: string;
      preferredElementSize?: "small";
      attributes?: {
        disabled?: boolean;
      };
    }>
  >(
    () => [
      {
        id: "branch",
        title: compactMenuBranchLabel(currentBranchLabel),
        subtitle: compactMenuStatus(gitStatus),
        image: "point.topleft.down.curvedto.point.bottomright.up",
        state: "off",
        preferredElementSize: "small",
        attributes: { disabled: true },
      },
      {
        id: "quick",
        title: quickAction.label,
        image:
          quickAction.kind === "run_pull"
            ? "arrow.down.circle"
            : quickAction.kind === "open_pr"
              ? "arrow.up.right.circle"
              : quickAction.action === "commit"
                ? "checkmark.circle"
                : quickAction.action === "push" || quickAction.action === "commit_push"
                  ? "arrow.up.circle"
                  : "arrow.up.right.circle",
        ...(quickActionHint ? { subtitle: quickActionHint } : {}),
        preferredElementSize: "small",
        ...(quickAction.disabled ? { attributes: { disabled: true } } : {}),
      },
      {
        id: "more",
        title: "More",
        image: "ellipsis.circle",
        subtitle: "Commit, files, branches",
        preferredElementSize: "small",
      },
    ],
    [
      currentBranchLabel,
      gitStatus,
      quickAction.action,
      quickAction.disabled,
      quickAction.kind,
      quickAction.label,
      quickActionHint,
    ],
  );

  useSheetVisibility(gitSheetRef, gitSheetVisible);
  useSheetVisibility(branchSheetRef, branchSheetVisible);
  useSheetVisibility(commitSheetRef, commitSheetVisible);
  useSheetVisibility(defaultBranchSheetRef, defaultBranchSheetVisible);

  useEffect(() => {
    if (!gitSheetVisible) {
      return;
    }
    void onRefreshStatus({ quiet: true });
  }, [gitSheetVisible, onRefreshStatus]);

  useEffect(() => {
    if (!branchSheetVisible) {
      return;
    }

    setWorktreeBaseBranch(currentBranchLabel === "Detached HEAD" ? "main" : currentBranchLabel);
    setBranchesLoading(true);
    void onListBranches()
      .then((branches) => setAvailableBranches(branches))
      .finally(() => setBranchesLoading(false));
  }, [branchSheetVisible, currentBranchLabel, onListBranches]);

  const closeTransientSheets = useCallback(() => {
    setGitSheetVisible(false);
    setCommitSheetVisible(false);
    setDefaultBranchSheetVisible(false);
  }, []);

  const openCommitSheet = useCallback(() => {
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setDialogCommitMessage("");
    setCommitSheetVisible(true);
  }, []);

  const openExistingPr = useCallback(async () => {
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Alert.alert("No open PR", "This branch does not have an open pull request.");
      return;
    }
    try {
      await Linking.openURL(prUrl);
    } catch (error) {
      Alert.alert(
        "Unable to open PR",
        error instanceof Error ? error.message : "An error occurred.",
      );
    }
  }, [gitStatus]);

  const runActionWithPrompt = useCallback(
    async (input: GitActionRequestInput) => {
      const confirmableAction =
        input.action === "push" ||
        input.action === "create_pr" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr"
          ? input.action
          : null;
      const branchName = gitStatus?.branch;
      if (
        branchName &&
        confirmableAction &&
        !input.featureBranch &&
        requiresDefaultBranchConfirmation(input.action, isDefaultBranch)
      ) {
        setPendingDefaultBranchAction({
          action: confirmableAction,
          branchName,
          includesCommit: input.action === "commit_push" || input.action === "commit_push_pr",
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(input.filePaths ? { filePaths: input.filePaths } : {}),
        });
        setDefaultBranchSheetVisible(true);
        return;
      }

      closeTransientSheets();
      await onRunAction(input);
    },
    [closeTransientSheets, gitStatus, isDefaultBranch, onRunAction],
  );

  const continuePendingDefaultBranchAction = useCallback(async () => {
    if (!pendingDefaultBranchAction) {
      return;
    }
    const action = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    setDefaultBranchSheetVisible(false);
    await onRunAction({
      action: action.action,
      ...(action.commitMessage ? { commitMessage: action.commitMessage } : {}),
      ...(action.filePaths ? { filePaths: action.filePaths } : {}),
    });
  }, [onRunAction, pendingDefaultBranchAction]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!pendingDefaultBranchAction) {
      return;
    }

    const action = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    setDefaultBranchSheetVisible(false);

    if (action.includesCommit) {
      await onRunAction({
        action: action.action,
        featureBranch: true,
        ...(action.commitMessage ? { commitMessage: action.commitMessage } : {}),
        ...(action.filePaths ? { filePaths: action.filePaths } : {}),
      });
      return;
    }

    const branches = await onListBranches();
    const branchName = resolveAutoFeatureBranchName(
      branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
    );
    await onCreateBranch(branchName);
    await onRunAction({ action: action.action });
  }, [onCreateBranch, onListBranches, onRunAction, pendingDefaultBranchAction]);

  const runQuickAction = useCallback(async () => {
    if (quickAction.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      await onPull();
      return;
    }
    if (quickAction.kind === "run_action" && quickAction.action) {
      await runActionWithPrompt({ action: quickAction.action });
    }
  }, [onPull, openExistingPr, quickAction, runActionWithPrompt]);

  const runCommitAction = useCallback(
    async (featureBranch: boolean) => {
      const commitMessage = dialogCommitMessage.trim();
      setGitSheetVisible(false);
      setCommitSheetVisible(false);
      await onRunAction({
        action: "commit",
        featureBranch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
      });
      setDialogCommitMessage("");
      setExcludedFiles(new Set());
    },
    [allSelected, dialogCommitMessage, onRunAction, selectedFiles],
  );

  const onPressMenuItem = useCallback(
    async (item: (typeof menuItems)[number]) => {
      if (item.disabled) {
        return;
      }
      if (item.kind === "open_pr") {
        await openExistingPr();
        return;
      }
      if (item.dialogAction === "commit") {
        openCommitSheet();
        return;
      }
      if (item.dialogAction === "push") {
        await runActionWithPrompt({ action: "push" });
        return;
      }
      if (item.dialogAction === "create_pr") {
        await runActionWithPrompt({ action: "create_pr" });
      }
    },
    [openCommitSheet, openExistingPr, runActionWithPrompt],
  );

  const onPressNativeMenuAction = useCallback(
    ({ nativeEvent }: { nativeEvent: { event: string } }) => {
      if (nativeEvent.event === "quick") {
        void runQuickAction();
        return;
      }
      if (nativeEvent.event === "more") {
        setGitSheetVisible(true);
      }
    },
    [runQuickAction],
  );

  return (
    <>
      <MenuView actions={nativeMenuActions} onPressAction={onPressNativeMenuAction}>
        <Pressable
          className="flex-row items-center gap-2 rounded-full px-3 py-2"
          style={{ backgroundColor: palette.subtleBg }}
        >
          <SymbolView
            name="point.topleft.down.curvedto.point.bottomright.up"
            size={14}
            tintColor={palette.icon}
            type="monochrome"
          />
          <View className="shrink">
            <Text
              className="text-[11px] font-t3-bold uppercase"
              numberOfLines={1}
              style={{ color: palette.textMuted, letterSpacing: 0.8 }}
            >
              Git
            </Text>
            <Text
              className="text-[12px] font-t3-bold"
              numberOfLines={1}
              style={{ color: palette.text }}
            >
              {triggerStatus}
            </Text>
          </View>
          <SymbolView
            name="chevron.down"
            size={11}
            tintColor={palette.textMuted}
            type="monochrome"
            weight="medium"
          />
        </Pressable>
      </MenuView>

      <BottomSheetModal
        ref={gitSheetRef}
        index={0}
        snapPoints={gitSnapPoints}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => setGitSheetVisible(false)}
        backgroundStyle={{ backgroundColor: palette.sheetBackground }}
        handleIndicatorStyle={{ backgroundColor: palette.dotSeparator }}
      >
        <BottomSheetView style={{ flex: 1 }}>
          <BottomSheetScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: 8,
              paddingBottom: Math.max(insets.bottom, 18) + 8,
              gap: 14,
            }}
          >
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1 gap-1">
                <Text
                  className="text-[11px] font-t3-bold uppercase"
                  style={{ color: palette.textMuted, letterSpacing: 1 }}
                >
                  Branch
                </Text>
                <Text className="text-[24px] font-t3-bold" style={{ color: palette.text }}>
                  {currentBranchLabel}
                </Text>
                <Text
                  className="text-[13px] font-medium leading-[19px]"
                  style={{ color: palette.textSecondary }}
                >
                  {statusSummary(gitStatus)}
                </Text>
              </View>
              <Pressable
                className="rounded-full p-2"
                disabled={busy}
                style={{ backgroundColor: palette.subtleBg, opacity: busy ? 0.45 : 1 }}
                onPress={() => void onRefreshStatus()}
              >
                <SymbolView
                  name="arrow.clockwise"
                  size={16}
                  tintColor={palette.icon}
                  type="monochrome"
                  weight="medium"
                />
              </Pressable>
            </View>

            <View className="gap-3">
              <View
                className="overflow-hidden rounded-[22px] border px-4 py-1"
                style={{ backgroundColor: palette.card, borderColor: palette.border }}
              >
                {sheetMenuItems.map(({ item, disabledReason }, index) => (
                  <View key={`${item.id}-${item.label}`}>
                    {index > 0 ? (
                      <View
                        className="ml-12 h-px"
                        style={{ backgroundColor: palette.border }}
                      />
                    ) : null}
                    <SheetListRow
                      icon={menuItemIconName(item.icon)}
                      title={item.label}
                      subtitle={disabledReason}
                      disabled={item.disabled}
                      onPress={() => {
                        void onPressMenuItem(item);
                      }}
                    />
                  </View>
                ))}
                {(gitStatus?.behindCount ?? 0) > 0 ? (
                  <>
                    <View
                      className="ml-12 h-px"
                      style={{ backgroundColor: palette.border }}
                    />
                    <SheetListRow
                      icon="arrow.down.circle"
                      title="Pull latest"
                      subtitle="Sync this branch with upstream"
                      disabled={busy || !isRepo}
                      onPress={() => {
                        void onPull();
                      }}
                    />
                  </>
                ) : null}
                <View className="ml-12 h-px" style={{ backgroundColor: palette.border }} />
                <SheetListRow
                  icon="point.topleft.down.curvedto.point.bottomright.up"
                  title="Branches & worktrees"
                  subtitle="Switch branch, create branch, or move to a worktree"
                  disabled={busy || !isRepo}
                  onPress={() => setBranchSheetVisible(true)}
                />
              </View>
            </View>

            {currentWorktreePath ? <MetaCard label="Worktree" value={currentWorktreePath} /> : null}

            {gitOperationLabel ? (
              <View className="self-start">
                <StatusPill
                  label={gitOperationLabel}
                  pillClassName="bg-slate-900/8"
                  textClassName="text-slate-700"
                  size="compact"
                />
              </View>
            ) : null}
          </BottomSheetScrollView>
        </BottomSheetView>
      </BottomSheetModal>

      <BottomSheetModal
        ref={commitSheetRef}
        stackBehavior="push"
        index={0}
        snapPoints={commitSnapPoints}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => setCommitSheetVisible(false)}
        backgroundStyle={{ backgroundColor: palette.sheetBackground }}
        handleIndicatorStyle={{ backgroundColor: palette.dotSeparator }}
      >
        <BottomSheetView style={{ flex: 1 }}>
          <BottomSheetScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: 8,
              paddingBottom: Math.max(insets.bottom, 18) + 8,
              gap: 16,
            }}
          >
            <View className="gap-1">
              <Text className="text-[24px] font-t3-bold" style={{ color: palette.text }}>
                Commit changes
              </Text>
              <Text className="text-[13px] font-medium leading-[19px]" style={{ color: palette.textSecondary }}>
                Review the file set, optionally write a message, then commit here or on a new
                feature branch.
              </Text>
            </View>

            <View
              className="gap-3 rounded-[22px] border px-4 py-4"
              style={{ backgroundColor: palette.card, borderColor: palette.border }}
            >
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-[13px] font-medium" style={{ color: palette.textMuted }}>
                  Branch
                </Text>
                <Text className="text-[15px] font-t3-bold" style={{ color: palette.text }}>
                  {gitStatus?.branch ?? "(detached HEAD)"}
                </Text>
              </View>
              {isDefaultBranch ? (
                <Text className="text-[12px] leading-[18px]" style={{ color: isDarkMode ? "#fbbf24" : "#b45309" }}>
                  Warning: this is the default branch.
                </Text>
              ) : null}
            </View>

            <View
              className="gap-3 rounded-[22px] border px-4 py-4"
              style={{ backgroundColor: palette.card, borderColor: palette.border }}
            >
              <View className="flex-row items-center justify-between gap-3">
                <View className="gap-1">
                  <Text className="text-[16px] font-t3-bold" style={{ color: palette.text }}>
                    Files
                  </Text>
                  <Text className="text-[12px] leading-[18px]" style={{ color: palette.textMuted }}>
                    {selectedFiles.length} selected · +{selectedInsertions} / -{selectedDeletions}
                  </Text>
                </View>
                <View className="flex-row items-center gap-2">
                  {!allSelected && isEditingFiles ? (
                    <Pressable
                      className="rounded-full px-3 py-2"
                      style={{ backgroundColor: palette.subtleBg }}
                      onPress={() => setExcludedFiles(new Set())}
                    >
                      <Text
                        className="text-[11px] font-t3-bold uppercase"
                        style={{ color: palette.text }}
                      >
                        Reset
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    className="rounded-full px-3 py-2"
                    style={{ backgroundColor: palette.subtleBg }}
                    onPress={() => setIsEditingFiles((current) => !current)}
                  >
                    <Text
                      className="text-[11px] font-t3-bold uppercase"
                      style={{ color: palette.text }}
                    >
                      {isEditingFiles ? "Done" : "Edit"}
                    </Text>
                  </Pressable>
                </View>
              </View>

              {allFiles.length === 0 ? (
                <Text className="text-[13px] leading-[19px]" style={{ color: palette.textSecondary }}>
                  No changed files are available to commit.
                </Text>
              ) : !isEditingFiles ? (
                <View className="gap-2">
                  {selectedFilePreview.map((file) => (
                    <View key={file.path} className="flex-row items-center justify-between gap-3">
                      <Text
                        className="flex-1 text-[13px] font-medium"
                        numberOfLines={1}
                        style={{ color: palette.text }}
                      >
                        {file.path}
                      </Text>
                      <Text className="text-[12px] font-t3-bold" style={{ color: "#10b981" }}>
                        +{file.insertions}
                      </Text>
                      <Text className="text-[12px] font-t3-bold" style={{ color: "#f43f5e" }}>
                        -{file.deletions}
                      </Text>
                    </View>
                  ))}
                  {selectedFiles.length > selectedFilePreview.length ? (
                    <Text className="text-[12px] leading-[17px]" style={{ color: palette.textMuted }}>
                      +{selectedFiles.length - selectedFilePreview.length} more files
                    </Text>
                  ) : null}
                </View>
              ) : (
                <View className="gap-2">
                  {allFiles.map((file) => {
                    const included = !excludedFiles.has(file.path);
                    return (
                      <Pressable
                        key={file.path}
                        className="rounded-[18px] border px-4 py-3"
                        style={{
                          backgroundColor: included ? palette.card : palette.subtleBg,
                          borderColor: included ? palette.border : palette.borderSubtle,
                        }}
                        onPress={() => {
                          setExcludedFiles((current) => {
                            const next = new Set(current);
                            if (next.has(file.path)) {
                              next.delete(file.path);
                            } else {
                              next.add(file.path);
                            }
                            return next;
                          });
                        }}
                      >
                        <View className="flex-row items-start justify-between gap-3">
                          <View className="flex-1 gap-1">
                            <Text
                              selectable
                              className="text-[13px] font-t3-bold"
                              style={{ color: included ? palette.text : palette.textMuted }}
                            >
                              {file.path}
                            </Text>
                            {!included ? (
                              <Text
                                className="text-[11px] leading-[16px]"
                                style={{ color: palette.textMuted }}
                              >
                                Excluded from this commit
                              </Text>
                            ) : null}
                          </View>
                          <View className="items-end gap-1">
                            <Text className="text-[12px] font-t3-bold" style={{ color: "#10b981" }}>
                              +{file.insertions}
                            </Text>
                            <Text className="text-[12px] font-t3-bold" style={{ color: "#f43f5e" }}>
                              -{file.deletions}
                            </Text>
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>

            <View className="gap-2">
              <Text className="text-[13px] font-t3-bold" style={{ color: palette.text }}>
                Commit message
              </Text>
              <TextInput
                multiline
                value={dialogCommitMessage}
                onChangeText={setDialogCommitMessage}
                placeholder="Leave empty to auto-generate"
                textAlignVertical="top"
                className="min-h-[128px] rounded-[20px] px-4 py-3.5 font-sans text-[15px]"
                style={{
                  minHeight: 128,
                  borderWidth: 1,
                  borderColor: palette.inputBorder,
                  backgroundColor: palette.inputBackground,
                  color: palette.text,
                }}
              />
            </View>

            <View className="flex-row gap-3">
              <View className="flex-1">
                <SheetActionButton
                  icon="arrow.branch"
                  label="Commit on new branch"
                  disabled={noneSelected || busy}
                  onPress={() => {
                    void runCommitAction(true);
                  }}
                />
              </View>
              <View className="flex-1">
                <SheetActionButton
                  icon="checkmark.circle"
                  label="Commit"
                  tone="primary"
                  disabled={noneSelected || busy}
                  onPress={() => {
                    void runCommitAction(false);
                  }}
                />
              </View>
            </View>
          </BottomSheetScrollView>
        </BottomSheetView>
      </BottomSheetModal>

      <BottomSheetModal
        ref={defaultBranchSheetRef}
        stackBehavior="push"
        index={0}
        snapPoints={defaultBranchSnapPoints}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => setDefaultBranchSheetVisible(false)}
        backgroundStyle={{ backgroundColor: palette.sheetBackground }}
        handleIndicatorStyle={{ backgroundColor: palette.dotSeparator }}
      >
        <BottomSheetView
          className="gap-4 px-5 pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 18) + 8 }}
        >
          <View className="gap-1">
            <Text className="text-[22px] font-t3-bold" style={{ color: palette.text }}>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default branch?"}
            </Text>
            <Text className="text-[13px] font-medium leading-[19px]" style={{ color: palette.textSecondary }}>
              {pendingDefaultBranchActionCopy?.description ?? "Choose how to continue."}
            </Text>
          </View>

          <View className="gap-3">
            <SheetActionButton
              icon="arrow.right.circle"
              label={pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
              onPress={() => {
                void continuePendingDefaultBranchAction();
              }}
            />
            <SheetActionButton
              icon="arrow.branch"
              label="Feature branch & continue"
              tone="primary"
              onPress={() => {
                void movePendingActionToFeatureBranch();
              }}
            />
          </View>
        </BottomSheetView>
      </BottomSheetModal>

      <BottomSheetModal
        ref={branchSheetRef}
        stackBehavior="push"
        index={0}
        snapPoints={branchSnapPoints}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => setBranchSheetVisible(false)}
        backgroundStyle={{ backgroundColor: palette.sheetBackground }}
        handleIndicatorStyle={{ backgroundColor: palette.dotSeparator }}
      >
        <BottomSheetView style={{ flex: 1 }}>
          <BottomSheetScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: 8,
              paddingBottom: Math.max(insets.bottom, 18) + 8,
              gap: 16,
            }}
          >
            <View className="gap-1">
              <Text className="text-[22px] font-t3-bold" style={{ color: palette.text }}>
                Branches & worktrees
              </Text>
              <Text className="text-[13px] font-medium leading-[19px]" style={{ color: palette.textSecondary }}>
                Switch this thread, create a branch, or move work onto its own worktree.
              </Text>
            </View>

            <View
              className="gap-2 rounded-[18px] border px-4 py-4"
              style={{ backgroundColor: palette.card, borderColor: palette.border }}
            >
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: palette.textSecondary, letterSpacing: 1 }}
              >
                New branch
              </Text>
              <TextInput
                value={newBranchName}
                onChangeText={setNewBranchName}
                placeholder="feature/mobile-polish"
                className="rounded-[18px] px-3.5 py-3 font-sans text-[15px]"
                style={{
                  borderWidth: 1,
                  borderColor: palette.inputBorder,
                  backgroundColor: palette.inputBackground,
                  color: palette.text,
                }}
              />
              <SheetActionButton
                icon="plus"
                label="Create & checkout"
                tone="primary"
                disabled={busy || newBranchName.trim().length === 0}
                onPress={() => {
                  const branch = sanitizeFeatureBranchName(newBranchName.trim());
                  if (branch.length === 0) {
                    return;
                  }
                  void onCreateBranch(branch).then(() => {
                    setNewBranchName("");
                    setBranchSheetVisible(false);
                  });
                }}
              />
            </View>

            <View
              className="gap-2 rounded-[18px] border px-4 py-4"
              style={{ backgroundColor: palette.card, borderColor: palette.border }}
            >
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: palette.textSecondary, letterSpacing: 1 }}
              >
                New worktree
              </Text>
              <TextInput
                value={worktreeBaseBranch}
                onChangeText={setWorktreeBaseBranch}
                placeholder="main"
                className="rounded-[18px] px-3.5 py-3 font-sans text-[15px]"
                style={{
                  borderWidth: 1,
                  borderColor: palette.inputBorder,
                  backgroundColor: palette.inputBackground,
                  color: palette.text,
                }}
              />
              <TextInput
                value={worktreeBranchName}
                onChangeText={setWorktreeBranchName}
                placeholder="feature/mobile-thread"
                className="rounded-[18px] px-3.5 py-3 font-sans text-[15px]"
                style={{
                  borderWidth: 1,
                  borderColor: palette.inputBorder,
                  backgroundColor: palette.inputBackground,
                  color: palette.text,
                }}
              />
              <SheetActionButton
                icon="square.split.2x1"
                label="Create worktree"
                tone="primary"
                disabled={
                  busy ||
                  worktreeBaseBranch.trim().length === 0 ||
                  worktreeBranchName.trim().length === 0
                }
                onPress={() => {
                  const baseBranch = worktreeBaseBranch.trim();
                  const newBranch = worktreeBranchName.trim();
                  if (baseBranch.length === 0 || newBranch.length === 0) {
                    return;
                  }
                  void onCreateWorktree({
                    baseBranch,
                    newBranch,
                  }).then(() => {
                    setWorktreeBranchName("");
                    setBranchSheetVisible(false);
                  });
                }}
              />
            </View>

            <View className="gap-2">
              <Text
                className="text-[11px] font-t3-bold uppercase"
                style={{ color: palette.textSecondary, letterSpacing: 1 }}
              >
                Existing branches
              </Text>
              {branchesLoading ? (
                <Text className="text-[13px] font-medium" style={{ color: palette.textSecondary }}>
                  Loading branches…
                </Text>
              ) : null}
              {!branchesLoading && availableBranches.length === 0 ? (
                <Text className="text-[13px] font-medium" style={{ color: palette.textSecondary }}>
                  No local branches found.
                </Text>
              ) : null}
              {availableBranches.map((branch) => {
                const disabled = disabledExistingBranches.has(branch.name);
                const subtitle = branch.worktreePath
                  ? branch.worktreePath === currentWorktreePath
                    ? "Checked out in this thread"
                    : "Checked out in another worktree"
                  : branch.isDefault
                    ? "Default branch"
                    : "Local branch";

                return (
                  <Pressable
                    key={branch.name}
                    className="gap-1 rounded-[18px] border px-4 py-3"
                    disabled={busy || disabled}
                    style={{
                      backgroundColor: palette.card,
                      borderColor: branch.current ? palette.subtleBgStrong : palette.border,
                      opacity: busy || disabled ? 0.45 : 1,
                    }}
                    onPress={() => {
                      void onCheckoutBranch(branch.name).then(() => {
                        setBranchSheetVisible(false);
                      });
                    }}
                  >
                    <Text className="text-[15px] font-t3-bold" style={{ color: palette.text }}>
                      {branch.name}
                    </Text>
                    <Text className="text-[12px] font-medium" style={{ color: palette.textSecondary }}>
                      {subtitle}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </BottomSheetScrollView>
        </BottomSheetView>
      </BottomSheetModal>
    </>
  );
}

import {
  type ExtensionActivityPayload,
  type PiExtensionDiagnosticPayload,
  type PiUiStateUpdatedPayload,
  ApprovalRequestId,
  RuntimeRequestId,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnId,
  type UserInputQuestion,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  Theme,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  type ExtensionWidgetOptions,
  type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { toPiJsonValue } from "./jsonSafe.ts";

export interface PiExtensionUiBridgeContext {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly activeTurnId: TurnId | undefined;
}

export type PiRuntimeEventPublisher = (event: ProviderRuntimeEvent) => Promise<void>;

interface PendingPiExtensionDialog {
  readonly kind: "select" | "confirm" | "input" | "editor";
  readonly resolve: (value: string | boolean | undefined) => void;
}

export interface PiExtensionUiBridge {
  readonly uiContext: ExtensionUIContext;
  readonly respond: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Promise<void>;
  readonly publishActivity: (activity: PiExtensionActivityInput) => Promise<void>;
  readonly publishDiagnostic: (diagnostic: PiExtensionDiagnosticInput) => Promise<void>;
  readonly dispose: () => void;
}

interface PiExtensionActivityInput {
  readonly activityType: ExtensionActivityPayload["activityType"];
  readonly message: string;
  readonly severity?: "info" | "warning" | "error";
  readonly extensionPath?: string;
  readonly data?: unknown;
}

interface PiUiStateInput {
  readonly surface: PiUiStateUpdatedPayload["surface"];
  readonly key: string;
  readonly label?: string;
  readonly text?: string;
  readonly lines?: readonly string[];
  readonly state?: PiUiStateUpdatedPayload["state"];
  readonly placement?: string;
  readonly extensionPath?: string;
  readonly data?: unknown;
}

interface PiExtensionDiagnosticInput {
  readonly message: string;
  readonly severity?: PiExtensionDiagnosticPayload["severity"];
  readonly visibility?: PiExtensionDiagnosticPayload["visibility"];
  readonly extensionPath?: string;
  readonly event?: string;
  readonly diagnosticKey?: string;
  readonly repeatCount?: number;
  readonly hiddenCount?: number;
  readonly detail?: unknown;
}

interface UiStatePublicationState {
  lastPublishedAt: number;
  lastSignature: string | null;
  pending: PiUiStateInput | null;
  pendingSignature: string | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

const UI_STATE_THROTTLE_MS = 250;
const ANSI_PATTERN = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, "g");

const fallbackFgColors = {
  accent: "#7aa2f7",
  border: "#6b7280",
  borderAccent: "#7aa2f7",
  borderMuted: "#4b5563",
  success: "#80c990",
  error: "#f7768e",
  warning: "#e0af68",
  muted: "#9ca3af",
  dim: "#6b7280",
  text: "#d1d5db",
  thinkingText: "#9ca3af",
  userMessageText: "#d1d5db",
  customMessageText: "#d1d5db",
  customMessageLabel: "#9ca3af",
  toolTitle: "#d1d5db",
  toolOutput: "#d1d5db",
  mdHeading: "#d1d5db",
  mdLink: "#7aa2f7",
  mdLinkUrl: "#9ca3af",
  mdCode: "#d1d5db",
  mdCodeBlock: "#d1d5db",
  mdCodeBlockBorder: "#4b5563",
  mdQuote: "#9ca3af",
  mdQuoteBorder: "#4b5563",
  mdHr: "#4b5563",
  mdListBullet: "#9ca3af",
  toolDiffAdded: "#80c990",
  toolDiffRemoved: "#f7768e",
  toolDiffContext: "#9ca3af",
  syntaxComment: "#6b7280",
  syntaxKeyword: "#bb9af7",
  syntaxFunction: "#7aa2f7",
  syntaxVariable: "#d1d5db",
  syntaxString: "#9ece6a",
  syntaxNumber: "#ff9e64",
  syntaxType: "#2ac3de",
  syntaxOperator: "#89ddff",
  syntaxPunctuation: "#9ca3af",
  thinkingOff: "#6b7280",
  thinkingMinimal: "#9ca3af",
  thinkingLow: "#7aa2f7",
  thinkingMedium: "#e0af68",
  thinkingHigh: "#ff9e64",
  thinkingXhigh: "#f7768e",
  bashMode: "#7aa2f7",
} satisfies Record<ThemeColor, string | number>;

const fallbackBgColors: ConstructorParameters<typeof Theme>[1] = {
  selectedBg: "#1f2937",
  userMessageBg: "#111827",
  customMessageBg: "#111827",
  toolPendingBg: "#111827",
  toolSuccessBg: "#111827",
  toolErrorBg: "#111827",
};

class PlainTextPiTheme extends Theme {
  constructor() {
    super(fallbackFgColors, fallbackBgColors, "truecolor", { name: "t3" });
  }

  override fg(_color: ThemeColor, text: string) {
    return text;
  }

  override bg(_color: Parameters<Theme["bg"]>[0], text: string) {
    return text;
  }

  override bold(text: string) {
    return text;
  }

  override italic(text: string) {
    return text;
  }

  override underline(text: string) {
    return text;
  }

  override inverse(text: string) {
    return text;
  }

  override strikethrough(text: string) {
    return text;
  }

  override getFgAnsi(_color: ThemeColor) {
    return "";
  }

  override getBgAnsi(_color: Parameters<Theme["bg"]>[0]) {
    return "";
  }

  override getThinkingBorderColor(_level: Parameters<Theme["getThinkingBorderColor"]>[0]) {
    return (text: string) => text;
  }

  override getBashModeBorderColor() {
    return (text: string) => text;
  }
}

const fallbackTheme = new PlainTextPiTheme();

function nowIso() {
  return new Date().toISOString();
}

function nextEventId() {
  return EventId.make(crypto.randomUUID());
}

function baseEvent(context: PiExtensionUiBridgeContext) {
  return {
    eventId: nextEventId(),
    provider: ProviderDriverKind.make("pi"),
    providerInstanceId: context.providerInstanceId,
    threadId: context.threadId,
    ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
    createdAt: nowIso(),
  };
}

function trimToMessage(value: string, fallback: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function stripAnsi(value: string) {
  return value.replace(ANSI_PATTERN, "");
}

function sanitizeDisplayText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : stripAnsi(value);
}

function uiStateKey(state: Pick<PiUiStateInput, "surface" | "key">) {
  return `${state.surface}:${state.key}`;
}

function uiStateSignature(state: PiUiStateInput) {
  return JSON.stringify({
    surface: state.surface,
    key: state.key,
    label: state.label,
    text: state.text,
    lines: state.lines,
    state: state.state,
    placement: state.placement,
  });
}

function makeQuestion(input: {
  readonly requestId: ApprovalRequestId;
  readonly kind: PendingPiExtensionDialog["kind"];
  readonly title: string;
  readonly message?: string | undefined;
  readonly options?: readonly string[] | undefined;
  readonly placeholder?: string | undefined;
  readonly prefill?: string | undefined;
}): UserInputQuestion {
  if (input.kind === "confirm") {
    return {
      id: input.requestId,
      header: trimToMessage(input.title, "Confirm"),
      question: trimToMessage(input.message ?? input.title, input.title),
      inputKind: "confirm",
      options: [
        { label: "Yes", description: "Yes" },
        { label: "No", description: "No" },
      ],
      multiSelect: false,
    };
  }

  if (input.kind === "input" || input.kind === "editor") {
    return {
      id: input.requestId,
      header: trimToMessage(input.title, input.kind === "input" ? "Input" : "Editor"),
      question: trimToMessage(input.message ?? input.title, input.title),
      inputKind: input.kind === "input" ? "text" : "textarea",
      options: [],
      ...(input.placeholder ? { placeholder: input.placeholder } : {}),
      ...(input.prefill ? { prefill: input.prefill } : {}),
      multiSelect: false,
    };
  }

  return {
    id: input.requestId,
    header: trimToMessage(input.title, "Select"),
    question: trimToMessage(input.message ?? input.title, input.title),
    inputKind: "select",
    options: (input.options ?? []).map((option) => ({
      label: trimToMessage(option, "Option"),
      description: trimToMessage(option, "Option"),
    })),
    multiSelect: false,
  };
}

function firstAnswer(answers: ProviderUserInputAnswers): unknown {
  const first = Object.values(answers)[0];
  return Array.isArray(first) ? first[0] : first;
}

function resolveDialogAnswer(
  kind: PendingPiExtensionDialog["kind"],
  answers: ProviderUserInputAnswers,
) {
  const answer = firstAnswer(answers);
  if (typeof answer !== "string") {
    return undefined;
  }
  if (kind === "confirm") {
    return answer.toLowerCase() === "yes";
  }
  return answer;
}

export function makePiExtensionUiBridge(input: {
  readonly getContext: () => PiExtensionUiBridgeContext;
  readonly publishRuntimeEvent: PiRuntimeEventPublisher;
}): PiExtensionUiBridge {
  const pendingDialogs = new Map<ApprovalRequestId, PendingPiExtensionDialog>();
  const uiStatePublications = new Map<string, UiStatePublicationState>();
  let editorText = "";
  let toolsExpanded = false;

  const publishActivity = async (activity: PiExtensionActivityInput) => {
    const data = toPiJsonValue(activity.data);
    await input.publishRuntimeEvent({
      ...baseEvent(input.getContext()),
      type: "extension.activity",
      payload: {
        source: "pi.extension.ui",
        activityType: activity.activityType,
        message: trimToMessage(activity.message, "Pi extension activity"),
        ...(activity.severity ? { severity: activity.severity } : {}),
        ...(activity.extensionPath ? { extensionPath: activity.extensionPath } : {}),
        ...(data !== undefined ? { data } : {}),
        uiOnly: true,
      },
    });
  };

  const publishDiagnostic = async (diagnostic: PiExtensionDiagnosticInput) => {
    const detail = toPiJsonValue(diagnostic.detail);
    await input.publishRuntimeEvent({
      ...baseEvent(input.getContext()),
      type: "pi.extension.diagnostic",
      payload: {
        source: "pi.extension",
        message: trimToMessage(diagnostic.message, "Pi extension diagnostic"),
        severity: diagnostic.severity ?? "warning",
        visibility: diagnostic.visibility ?? "pi-panel",
        ...(diagnostic.extensionPath ? { extensionPath: diagnostic.extensionPath } : {}),
        ...(diagnostic.event ? { event: diagnostic.event } : {}),
        ...(diagnostic.diagnosticKey ? { diagnosticKey: diagnostic.diagnosticKey } : {}),
        ...(diagnostic.repeatCount ? { repeatCount: diagnostic.repeatCount } : {}),
        ...(diagnostic.hiddenCount !== undefined ? { hiddenCount: diagnostic.hiddenCount } : {}),
        ...(detail !== undefined ? { detail } : {}),
        uiOnly: true,
      },
    });
  };

  const publishUiStateNow = async (state: PiUiStateInput) => {
    const publicationKey = uiStateKey(state);
    const publicationState = uiStatePublications.get(publicationKey);
    const signature = uiStateSignature(state);
    if (publicationState) {
      publicationState.lastPublishedAt = Date.now();
      publicationState.lastSignature = signature;
      publicationState.pendingSignature = null;
    }
    const data = toPiJsonValue(state.data);

    await input.publishRuntimeEvent({
      ...baseEvent(input.getContext()),
      type: "pi.ui.state.updated",
      payload: {
        source: "pi.extension.ui",
        surface: state.surface,
        key: trimToMessage(state.key, state.surface),
        ...(state.label ? { label: state.label } : {}),
        ...(state.text !== undefined ? { text: sanitizeDisplayText(state.text) } : {}),
        ...(state.lines ? { lines: state.lines.map(stripAnsi) } : {}),
        ...(state.state ? { state: state.state } : {}),
        ...(state.placement ? { placement: state.placement } : {}),
        ...(state.extensionPath ? { extensionPath: state.extensionPath } : {}),
        ...(data !== undefined ? { data } : {}),
        uiOnly: true,
      },
    });
  };

  const publishUiState = (state: PiUiStateInput, options?: { readonly throttle?: boolean }) => {
    const publicationKey = uiStateKey(state);
    const signature = uiStateSignature(state);
    const existing = uiStatePublications.get(publicationKey);
    const publicationState =
      existing ??
      ({
        lastPublishedAt: 0,
        lastSignature: null,
        pending: null,
        pendingSignature: null,
        timeout: null,
      } satisfies UiStatePublicationState);
    if (!existing) {
      uiStatePublications.set(publicationKey, publicationState);
    }

    if (
      publicationState.lastSignature === signature ||
      publicationState.pendingSignature === signature
    ) {
      return;
    }

    if (!options?.throttle) {
      if (publicationState.timeout) {
        clearTimeout(publicationState.timeout);
        publicationState.timeout = null;
        publicationState.pending = null;
        publicationState.pendingSignature = null;
      }
      void publishUiStateNow(state);
      return;
    }

    const elapsed = Date.now() - publicationState.lastPublishedAt;
    if (elapsed >= UI_STATE_THROTTLE_MS) {
      void publishUiStateNow(state);
      return;
    }

    publicationState.pending = state;
    publicationState.pendingSignature = signature;
    if (publicationState.timeout) {
      return;
    }

    publicationState.timeout = setTimeout(() => {
      publicationState.timeout = null;
      const pending = publicationState.pending;
      publicationState.pending = null;
      publicationState.pendingSignature = null;
      if (pending) {
        void publishUiStateNow(pending);
      }
    }, UI_STATE_THROTTLE_MS - elapsed);
    publicationState.timeout.unref?.();
  };

  const openDialog = <T extends string | boolean>(dialog: {
    readonly kind: PendingPiExtensionDialog["kind"];
    readonly title: string;
    readonly message?: string | undefined;
    readonly options?: readonly string[] | undefined;
    readonly placeholder?: string | undefined;
    readonly prefill?: string | undefined;
    readonly opts?: ExtensionUIDialogOptions | undefined;
  }) =>
    new Promise<T | undefined>((resolve) => {
      if (dialog.opts?.signal?.aborted) {
        resolve(undefined);
        return;
      }

      const requestId = ApprovalRequestId.make(crypto.randomUUID());
      pendingDialogs.set(requestId, {
        kind: dialog.kind,
        resolve: (value) => resolve(value as T | undefined),
      });

      const abort = () => {
        pendingDialogs.delete(requestId);
        resolve(undefined);
      };
      dialog.opts?.signal?.addEventListener("abort", abort, { once: true });

      if (dialog.opts?.timeout && dialog.opts.timeout > 0) {
        setTimeout(abort, dialog.opts.timeout).unref?.();
      }

      void input.publishRuntimeEvent({
        ...baseEvent(input.getContext()),
        type: "user-input.requested",
        requestId: RuntimeRequestId.make(requestId),
        payload: {
          questions: [
            makeQuestion({
              requestId,
              kind: dialog.kind,
              title: dialog.title,
              message: dialog.message,
              options: dialog.options,
              placeholder: dialog.placeholder,
              prefill: dialog.prefill,
            }),
          ],
        },
      });
    });

  const publishUnsupportedUi = (input: {
    readonly surface: PiUiStateInput["surface"];
    readonly key: string;
    readonly message: string;
    readonly data?: unknown;
  }) => {
    publishUiState({
      surface: input.surface,
      key: input.key,
      text: input.message,
      state: "unsupported",
      data: input.data,
    });
    void publishDiagnostic({
      message: input.message,
      severity: "warning",
      detail: input.data,
    });
  };

  const uiContext: ExtensionUIContext = {
    select: (title, options, opts) => openDialog({ kind: "select", title, options, opts }),
    confirm: async (title, message, opts) => {
      const value = await openDialog<boolean>({ kind: "confirm", title, message, opts });
      return value === true;
    },
    input: (title, placeholder, opts) => openDialog({ kind: "input", title, placeholder, opts }),
    notify: (message, type = "info") => {
      void publishActivity({ activityType: "notify", message: stripAnsi(message), severity: type });
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      publishUiState(
        {
          surface: "status",
          key,
          label: key,
          ...(text === undefined ? { state: "cleared" } : { text, state: "set" }),
        },
        { throttle: true },
      );
    },
    setWorkingMessage: (message) => {
      publishUiState(
        {
          surface: "status",
          key: "working",
          label: "working",
          ...(message === undefined ? { state: "cleared" } : { text: message, state: "set" }),
        },
        { throttle: true },
      );
    },
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (
      key: string,
      content: string[] | ((...args: ReadonlyArray<never>) => unknown) | undefined,
      options?: ExtensionWidgetOptions,
    ) => {
      if (Array.isArray(content)) {
        publishUiState({
          surface: "widget",
          key,
          label: key,
          lines: content,
          state: "set",
          ...(options?.placement ? { placement: options.placement } : {}),
          data: { options },
        });
        return;
      }
      if (content === undefined) {
        publishUiState({ surface: "widget", key, state: "cleared" });
        return;
      }
      if (typeof content === "function") {
        publishUnsupportedUi({
          surface: "widget",
          key,
          message: "Custom widget rendering is not available in T3 yet.",
          data: { key, options },
        });
      }
    },
    setFooter: (factory) => {
      if (factory) {
        publishUnsupportedUi({
          surface: "footer",
          key: "custom",
          message: "Custom footer rendering is not available in T3 yet.",
          data: { surface: "footer" },
        });
        return;
      }
      publishUiState({ surface: "footer", key: "custom", state: "cleared" });
    },
    setHeader: (factory) => {
      if (factory) {
        publishUnsupportedUi({
          surface: "header",
          key: "custom",
          message: "Custom header rendering is not available in T3 yet.",
          data: { surface: "header" },
        });
        return;
      }
      publishUiState({ surface: "header", key: "custom", state: "cleared" });
    },
    setTitle: (title) => {
      publishUiState({ surface: "title", key: "title", label: "title", text: title });
    },
    custom: async () => {
      await publishDiagnostic({
        message: "Custom Pi UI is not available in T3 yet.",
        severity: "warning",
      });
      return undefined as never;
    },
    pasteToEditor: (text) => {
      editorText = `${editorText}${text}`;
      publishUiState({
        surface: "editor",
        key: "composer",
        text: editorText,
        state: "set",
        data: { action: "paste" },
      });
    },
    setEditorText: (text) => {
      editorText = text;
      publishUiState({
        surface: "editor",
        key: "composer",
        text,
        state: "set",
        data: { action: "set" },
      });
    },
    getEditorText: () => editorText,
    editor: (title, prefill) => openDialog({ kind: "editor", title, prefill }),
    addAutocompleteProvider: () => {},
    setEditorComponent: (factory) => {
      if (factory) {
        publishUnsupportedUi({
          surface: "editor",
          key: "custom",
          message: "Custom editor rendering is not available in T3 yet.",
          data: { surface: "editor" },
        });
      } else {
        publishUiState({ surface: "editor", key: "custom", state: "cleared" });
      }
    },
    getEditorComponent: () => undefined,
    theme: fallbackTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({
      success: false,
      error: "T3 Pi theme switching is not implemented yet.",
    }),
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded: (expanded) => {
      toolsExpanded = expanded;
    },
  };

  return {
    uiContext,
    publishActivity,
    publishDiagnostic,
    respond: async (requestId, answers) => {
      const pending = pendingDialogs.get(requestId);
      if (!pending) {
        throw new Error(`Unknown pending Pi extension input request: ${requestId}`);
      }
      pendingDialogs.delete(requestId);
      pending.resolve(resolveDialogAnswer(pending.kind, answers));
    },
    dispose: () => {
      for (const publication of uiStatePublications.values()) {
        if (publication.timeout) {
          clearTimeout(publication.timeout);
        }
      }
      uiStatePublications.clear();
      for (const pending of pendingDialogs.values()) {
        pending.resolve(undefined);
      }
      pendingDialogs.clear();
    },
  };
}

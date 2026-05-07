import {
  type ExtensionActivityPayload,
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
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
} from "@mariozechner/pi-coding-agent";

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
  readonly dispose: () => void;
}

interface PiExtensionActivityInput {
  readonly activityType: ExtensionActivityPayload["activityType"];
  readonly message: string;
  readonly severity?: "info" | "warning" | "error";
  readonly extensionPath?: string;
  readonly data?: unknown;
}

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
  let editorText = "";
  let toolsExpanded = false;

  const publishActivity = async (activity: PiExtensionActivityInput) => {
    await input.publishRuntimeEvent({
      ...baseEvent(input.getContext()),
      type: "extension.activity",
      payload: {
        source: "pi.extension.ui",
        activityType: activity.activityType,
        message: trimToMessage(activity.message, "Pi extension activity"),
        ...(activity.severity ? { severity: activity.severity } : {}),
        ...(activity.extensionPath ? { extensionPath: activity.extensionPath } : {}),
        ...(activity.data !== undefined ? { data: activity.data } : {}),
        uiOnly: true,
      },
    });
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

  const unsupportedComponent = (activityType: "custom-ui" | "widget", data?: unknown) => {
    void publishActivity({
      activityType,
      message: "custom ui coming soon",
      data,
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
      void publishActivity({ activityType: "notify", message, severity: type });
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      void publishActivity({
        activityType: "status",
        message: text ? `${key}: ${text}` : `${key}: cleared`,
        data: { key, text },
      });
    },
    setWorkingMessage: (message) => {
      if (message) void publishActivity({ activityType: "status", message });
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
        void publishActivity({
          activityType: "widget",
          message: content.length > 0 ? `${key}: ${content.join("\n")}` : `${key}: cleared`,
          data: { key, content, options },
        });
        return;
      }
      if (typeof content === "function") {
        unsupportedComponent("custom-ui", { key, options });
      }
    },
    setFooter: (factory) => {
      if (factory) unsupportedComponent("custom-ui", { surface: "footer" });
    },
    setHeader: (factory) => {
      if (factory) unsupportedComponent("custom-ui", { surface: "header" });
    },
    setTitle: (title) => {
      void publishActivity({ activityType: "title", message: title });
    },
    custom: async () => {
      await publishActivity({
        activityType: "custom-ui",
        message: "custom ui coming soon",
      });
      return undefined as never;
    },
    pasteToEditor: (text) => {
      editorText = `${editorText}${text}`;
      void publishActivity({ activityType: "editor", message: text, data: { action: "paste" } });
    },
    setEditorText: (text) => {
      editorText = text;
      void publishActivity({ activityType: "editor", message: text, data: { action: "set" } });
    },
    getEditorText: () => editorText,
    editor: (title, prefill) => openDialog({ kind: "editor", title, prefill }),
    addAutocompleteProvider: () => {},
    setEditorComponent: (factory) => {
      if (factory) unsupportedComponent("custom-ui", { surface: "editor" });
    },
    getEditorComponent: () => undefined,
    theme: {} as ExtensionUIContext["theme"],
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
    respond: async (requestId, answers) => {
      const pending = pendingDialogs.get(requestId);
      if (!pending) {
        throw new Error(`Unknown pending Pi extension input request: ${requestId}`);
      }
      pendingDialogs.delete(requestId);
      pending.resolve(resolveDialogAnswer(pending.kind, answers));
    },
    dispose: () => {
      for (const pending of pendingDialogs.values()) {
        pending.resolve(undefined);
      }
      pendingDialogs.clear();
    },
  };
}

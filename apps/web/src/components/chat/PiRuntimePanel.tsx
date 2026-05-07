import type { OrchestrationThreadActivity, ServerProvider } from "@t3tools/contracts";
import { AlertTriangleIcon, ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useMemo } from "react";

import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
} from "../../providerSkillPresentation";
import type { Thread } from "../../types";
import { basenameOfPath } from "../../vscode-icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "~/lib/utils";

export type PiRuntimePanelTab = "home" | "extensions" | "logs";

interface PiPanelRow {
  readonly key: string;
  readonly surface: string;
  readonly label: string;
  readonly text: string;
  readonly state?: "set" | "cleared" | "unsupported";
}

interface PiPanelWidget {
  readonly key: string;
  readonly surface: "widget";
  readonly label: string;
  readonly lines: readonly string[];
  readonly text?: string | undefined;
  readonly state?: "set" | "cleared" | "unsupported";
}

interface PiPanelExtension {
  readonly path: string;
  readonly name: string;
  readonly tools: number;
  readonly commands: number;
}

interface PiPanelLog {
  readonly id: string;
  readonly createdAt: string;
  readonly severity: "info" | "warning" | "error";
  readonly source: string;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly hiddenCount: number;
}

export interface PiRuntimePanelState {
  readonly summaryStatus: string | null;
  readonly issueCount: number;
  readonly statuses: readonly PiPanelRow[];
  readonly headers: readonly PiPanelRow[];
  readonly footers: readonly PiPanelRow[];
  readonly title: string | null;
  readonly widgets: readonly PiPanelWidget[];
  readonly extensions: readonly PiPanelExtension[];
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
  readonly slashCommands: ServerProvider["slashCommands"];
  readonly skills: ServerProvider["skills"];
  readonly logs: readonly PiPanelLog[];
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly model: string | null;
}

interface PiRuntimePanelProps {
  readonly state: PiRuntimePanelState;
  readonly tab: PiRuntimePanelTab;
  readonly onTabChange: (tab: PiRuntimePanelTab) => void;
  readonly onClose: () => void;
}

interface PiRuntimePanelTriggerProps {
  readonly state: PiRuntimePanelState;
  readonly open: boolean;
  readonly compact: boolean;
  readonly onToggle: () => void;
}

const PANEL_TABS: ReadonlyArray<{ readonly id: PiRuntimePanelTab; readonly label: string }> = [
  { id: "home", label: "Home" },
  { id: "extensions", label: "Extensions" },
  { id: "logs", label: "Logs" },
];

const PI_UI_SURFACES = new Set(["header", "footer", "status", "widget", "title", "editor"]);
const PI_UI_STATES = new Set(["set", "cleared", "unsupported"]);
const DIAGNOSTIC_SEVERITIES = new Set(["info", "warning", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function readSlashCommands(value: unknown): ServerProvider["slashCommands"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = readString(entry.name);
    if (!name) return [];
    const description = readString(entry.description);
    const input = isRecord(entry.input) ? entry.input : null;
    const hint = readString(input?.hint);
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

function readProviderModels(value: unknown): ReadonlyArray<ServerProvider["models"][number]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const slug = readString(entry.slug);
    const name = readString(entry.name);
    if (!slug || !name) return [];
    const shortName = readString(entry.shortName);
    const subProvider = readString(entry.subProvider);
    const capabilities = isRecord(entry.capabilities)
      ? (entry.capabilities as ServerProvider["models"][number]["capabilities"])
      : null;
    return [
      {
        slug,
        name,
        ...(shortName ? { shortName } : {}),
        ...(subProvider ? { subProvider } : {}),
        isCustom: typeof entry.isCustom === "boolean" ? entry.isCustom : false,
        capabilities,
      },
    ];
  });
}

function readState(value: unknown): PiPanelRow["state"] | undefined {
  return typeof value === "string" && PI_UI_STATES.has(value)
    ? (value as PiPanelRow["state"])
    : undefined;
}

function readSeverity(value: unknown): PiPanelLog["severity"] {
  return typeof value === "string" && DIAGNOSTIC_SEVERITIES.has(value)
    ? (value as PiPanelLog["severity"])
    : "info";
}

function compactText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function formatSummaryStatus(row: PiPanelRow | undefined): string | null {
  if (!row) return null;
  const text = compactText(row.text);
  if (!text) return null;
  if (text.toLowerCase().startsWith(row.label.toLowerCase())) {
    return text;
  }
  return `${row.label} ${text}`;
}

function displayPathName(path: string): string {
  return basenameOfPath(path) || path;
}

function activityOrder(left: OrchestrationThreadActivity, right: OrchestrationThreadActivity) {
  const bySequence = (left.sequence ?? 0) - (right.sequence ?? 0);
  if (bySequence !== 0) return bySequence;
  return left.createdAt.localeCompare(right.createdAt);
}

export function derivePiRuntimePanelState(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly provider: ServerProvider | null | undefined;
  readonly skills: ServerProvider["skills"] | undefined;
  readonly cwd: string | null | undefined;
  readonly branch: string | null | undefined;
  readonly model: string | null | undefined;
}): PiRuntimePanelState {
  const uiState = new Map<string, PiPanelRow | PiPanelWidget>();
  const diagnostics = new Map<string, PiPanelLog>();
  const providerPi = input.provider?.pi;
  let extensionPaths: readonly string[] = providerPi?.extensionPaths ?? [];
  let models: ReadonlyArray<ServerProvider["models"][number]> = input.provider?.models ?? [];
  let slashCommands: ServerProvider["slashCommands"] = input.provider?.slashCommands ?? [];
  let commandCount = slashCommands.length;
  let toolCount = providerPi?.tools.length ?? 0;

  for (const activity of [...input.activities].toSorted(activityOrder)) {
    if (activity.kind === "pi.ui.state.updated" && isRecord(activity.payload)) {
      const surface = readString(activity.payload.surface);
      const key = readString(activity.payload.key);
      if (!surface || !key || !PI_UI_SURFACES.has(surface)) {
        continue;
      }
      const state = readState(activity.payload.state) ?? "set";
      const mapKey = `${surface}:${key}`;
      if (state === "cleared") {
        uiState.delete(mapKey);
        continue;
      }
      const label = readString(activity.payload.label) ?? key;
      const text = readString(activity.payload.text) ?? "";
      if (surface === "widget") {
        uiState.set(mapKey, {
          key,
          surface: "widget",
          label,
          text,
          lines: readStringArray(activity.payload.lines),
          state,
        });
      } else {
        uiState.set(mapKey, { key, surface, label, text, state });
      }
      continue;
    }

    if (activity.kind === "pi.extension.configured" && isRecord(activity.payload)) {
      extensionPaths = readStringArray(activity.payload.extensionPaths);
      slashCommands = readSlashCommands(activity.payload.slashCommands);
      commandCount = slashCommands.length;
      toolCount = Array.isArray(activity.payload.tools) ? activity.payload.tools.length : 0;
      models = readProviderModels(activity.payload.models);
      continue;
    }

    if (activity.kind === "pi.extension.diagnostic" && isRecord(activity.payload)) {
      const message = readString(activity.payload.message);
      if (!message) continue;
      const key = readString(activity.payload.diagnosticKey) ?? activity.id;
      const extensionPath = readString(activity.payload.extensionPath);
      const event = readString(activity.payload.event);
      const hiddenCount =
        typeof activity.payload.hiddenCount === "number" ? activity.payload.hiddenCount : 0;
      diagnostics.set(key, {
        id: activity.id,
        createdAt: activity.createdAt,
        severity: readSeverity(activity.payload.severity),
        source: extensionPath ? displayPathName(extensionPath) : event || "pi",
        message,
        detail: event && extensionPath ? event : undefined,
        hiddenCount,
      });
      continue;
    }

    if (activity.kind === "extension.activity" && isRecord(activity.payload)) {
      const message = readString(activity.payload.message);
      if (!message) continue;
      diagnostics.set(activity.id, {
        id: activity.id,
        createdAt: activity.createdAt,
        severity: readSeverity(activity.payload.severity),
        source: (() => {
          const extensionPath = readString(activity.payload.extensionPath);
          return extensionPath ? displayPathName(extensionPath) : "notify";
        })(),
        message,
        hiddenCount: 0,
      });
    }
  }

  const rows = Array.from(uiState.values());
  const panelRows = rows.filter((row): row is PiPanelRow => !("lines" in row));
  const headers = panelRows.filter((row) => row.surface === "header");
  const footers = panelRows.filter((row) => row.surface === "footer");
  const statusRows = panelRows.filter((row) => row.surface === "status");
  const widgets = rows.filter((row): row is PiPanelWidget => "lines" in row);
  const titleRow = uiState.get("title:title");
  const title = titleRow && !("lines" in titleRow) ? (compactText(titleRow.text) ?? null) : null;
  const summaryStatus =
    formatSummaryStatus(statusRows.find((row) => row.key === "tps")) ??
    formatSummaryStatus(statusRows.find((row) => row.key !== "working")) ??
    formatSummaryStatus(statusRows[0]);
  const logs = Array.from(diagnostics.values()).toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  const issueCount = logs.filter(
    (log) => log.severity === "warning" || log.severity === "error",
  ).length;
  const perExtensionCommandCount =
    extensionPaths.length > 0 ? Math.floor(commandCount / extensionPaths.length) : 0;
  const perExtensionToolCount =
    extensionPaths.length > 0 ? Math.floor(toolCount / extensionPaths.length) : 0;

  return {
    summaryStatus,
    issueCount,
    statuses: statusRows,
    headers,
    footers,
    title,
    widgets,
    extensions: extensionPaths.map((path) => ({
      path,
      name: displayPathName(path),
      commands: perExtensionCommandCount,
      tools: perExtensionToolCount,
    })),
    models,
    slashCommands,
    skills: input.skills ?? input.provider?.skills ?? [],
    logs,
    cwd: input.cwd ?? null,
    branch: input.branch ?? null,
    model: input.model ?? null,
  };
}

export function usePiRuntimePanelState(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity> | undefined;
  readonly provider: ServerProvider | null | undefined;
  readonly skills: ServerProvider["skills"] | undefined;
  readonly thread: Thread | null | undefined;
  readonly gitCwd: string | null | undefined;
  readonly model: string | null | undefined;
}) {
  return useMemo(
    () =>
      derivePiRuntimePanelState({
        activities: input.activities ?? [],
        provider: input.provider,
        skills: input.skills,
        cwd: input.thread?.worktreePath ?? input.gitCwd ?? null,
        branch: input.thread?.branch ?? null,
        model: input.model ?? null,
      }),
    [input.activities, input.gitCwd, input.model, input.provider, input.skills, input.thread],
  );
}

export function PiRuntimePanelTrigger(props: PiRuntimePanelTriggerProps) {
  const summary = props.compact ? null : props.state.summaryStatus;
  const Icon = props.open ? ChevronUpIcon : ChevronDownIcon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn(
        "h-7 max-w-56 gap-1.5 px-2 text-muted-foreground hover:text-foreground",
        props.open && "bg-accent text-foreground",
      )}
      aria-expanded={props.open}
      aria-label="Toggle Pi panel"
      onClick={props.onToggle}
    >
      <span className="font-medium text-foreground/85">Pi</span>
      {summary ? <span className="truncate text-muted-foreground">{summary}</span> : null}
      {props.state.issueCount > 0 ? (
        <Badge variant="warning" size="sm" className="h-4 min-w-4 px-1">
          {props.state.issueCount}
        </Badge>
      ) : null}
      <Icon className="size-3.5" />
    </Button>
  );
}

export function PiRuntimePanel(props: PiRuntimePanelProps) {
  return (
    <div className="flex h-[min(18rem,40vh)] min-h-0 flex-col border-b border-border/65 bg-muted/15">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/55 px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-foreground text-sm font-medium">Pi</span>
          {props.state.summaryStatus ? (
            <span className="truncate text-muted-foreground text-xs">
              {props.state.summaryStatus}
            </span>
          ) : null}
          {props.state.issueCount > 0 ? (
            <Badge variant="warning" size="sm">
              {props.state.issueCount}
            </Badge>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close Pi panel"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="flex gap-1 px-3 pt-2 sm:px-4" role="tablist" aria-label="Pi panel sections">
        {PANEL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={props.tab === tab.id}
            className={cn(
              "rounded-md px-2 py-1 text-xs transition-colors",
              props.tab === tab.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            onClick={() => props.onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
        <div className="px-3 py-3 sm:px-4">{renderPanelTab(props.state, props.tab)}</div>
      </ScrollArea>
    </div>
  );
}

function renderPanelTab(state: PiRuntimePanelState, tab: PiRuntimePanelTab) {
  switch (tab) {
    case "home":
      return <PiPanelHome state={state} />;
    case "extensions":
      return <PiPanelExtensions state={state} />;
    case "logs":
      return <PiPanelLogs logs={state.logs} />;
  }
}

function PiPanelHome({ state }: { readonly state: PiRuntimePanelState }) {
  return (
    <div className="space-y-3 text-xs">
      {state.title || state.headers.length > 0 ? (
        <section className="space-y-1">
          <PiPanelSectionLabel>Header</PiPanelSectionLabel>
          {state.title ? <PiKeyValue label="title" value={state.title} /> : null}
          {state.headers.map((row) => (
            <PiKeyValue
              key={row.key}
              label={row.label}
              value={row.text}
              muted={row.state === "unsupported"}
            />
          ))}
        </section>
      ) : null}

      <section className="space-y-1">
        <PiPanelSectionLabel>Status</PiPanelSectionLabel>
        {state.statuses.length > 0 ? (
          state.statuses.map((row) => (
            <PiKeyValue
              key={row.key}
              label={row.label}
              value={row.text}
              muted={row.state === "unsupported"}
            />
          ))
        ) : (
          <PiEmptyLine>No active status</PiEmptyLine>
        )}
      </section>

      <section className="space-y-1">
        <PiPanelSectionLabel>Widgets</PiPanelSectionLabel>
        {state.widgets.length > 0 ? (
          state.widgets.map((widget) => (
            <div key={widget.key} className="min-w-0">
              <div className="text-muted-foreground">{widget.label}</div>
              <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-background/50 px-2 py-1.5 font-mono text-[11px] text-foreground">
                {widget.lines.length > 0 ? widget.lines.join("\n") : widget.text}
              </pre>
            </div>
          ))
        ) : (
          <PiEmptyLine>No active widgets</PiEmptyLine>
        )}
      </section>

      <section className="space-y-1">
        <PiPanelSectionLabel>Footer</PiPanelSectionLabel>
        {state.cwd ? <PiKeyValue label="cwd" value={state.cwd} /> : null}
        {state.branch ? <PiKeyValue label="branch" value={state.branch} /> : null}
        {state.model ? <PiKeyValue label="model" value={state.model} /> : null}
        {state.footers.map((row) => (
          <PiKeyValue
            key={row.key}
            label={row.label}
            value={row.text}
            muted={row.state === "unsupported"}
          />
        ))}
      </section>
    </div>
  );
}

function PiPanelExtensions({ state }: { readonly state: PiRuntimePanelState }) {
  return (
    <div className="space-y-3 text-xs">
      <section className="space-y-1.5">
        <PiPanelSectionLabel>Extensions</PiPanelSectionLabel>
        {state.extensions.length > 0 ? (
          state.extensions.map((extension) => (
            <div key={extension.path} className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-foreground">{extension.name}</div>
                <div className="truncate text-muted-foreground">{extension.path}</div>
              </div>
              <span className="shrink-0 text-muted-foreground">active</span>
            </div>
          ))
        ) : (
          <PiEmptyLine>No extension snapshot yet</PiEmptyLine>
        )}
      </section>

      <section className="space-y-1.5">
        <PiPanelSectionLabel>Skills</PiPanelSectionLabel>
        {state.skills.length > 0 ? (
          state.skills.map((skill) => {
            const source = formatProviderSkillInstallSource(skill);
            return (
              <div key={skill.name} className="flex min-w-0 items-center justify-between gap-3">
                <span className="truncate text-foreground">
                  {formatProviderSkillDisplayName(skill)}
                </span>
                {source ? <span className="shrink-0 text-muted-foreground">{source}</span> : null}
              </div>
            );
          })
        ) : (
          <PiEmptyLine>No Pi skills loaded</PiEmptyLine>
        )}
      </section>
    </div>
  );
}

function PiPanelLogs({ logs }: { readonly logs: readonly PiPanelLog[] }) {
  if (logs.length === 0) {
    return <PiEmptyLine>No Pi logs yet</PiEmptyLine>;
  }
  return (
    <div className="space-y-2 text-xs">
      {logs.slice(0, 12).map((log) => (
        <div key={log.id} className="flex min-w-0 gap-2">
          <span
            className={cn(
              "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm",
              log.severity === "error"
                ? "text-destructive-foreground"
                : log.severity === "warning"
                  ? "text-warning-foreground"
                  : "text-muted-foreground",
            )}
          >
            {log.severity === "info" ? null : <AlertTriangleIcon className="size-3" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-muted-foreground">{log.severity}</span>
              <span className="truncate text-foreground">{log.source}</span>
            </div>
            <div className="mt-0.5 text-muted-foreground">{log.message}</div>
            {log.hiddenCount > 0 ? (
              <div className="mt-0.5 text-muted-foreground/70">
                {log.hiddenCount} repeats hidden
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function PiPanelSectionLabel({ children }: { readonly children: string }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">
      {children}
    </div>
  );
}

function PiKeyValue(props: {
  readonly label: string;
  readonly value: string;
  readonly muted?: boolean;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <span className="truncate text-muted-foreground">{props.label}</span>
      <span
        className={cn("min-w-0 truncate text-foreground", props.muted && "text-muted-foreground")}
      >
        {props.value}
      </span>
    </div>
  );
}

function PiEmptyLine({ children }: { readonly children: string }) {
  return <div className="text-muted-foreground/70">{children}</div>;
}

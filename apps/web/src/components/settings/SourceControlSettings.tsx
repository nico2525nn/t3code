import { ChevronDownIcon, GitBranchIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { Option } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SourceControlDiscoveryItem,
  SourceControlDiscoveryResult,
  SourceControlProviderDiscoveryItem,
  VcsDiscoveryItem,
} from "@t3tools/contracts";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type DiscoveryLoadState =
  | { readonly status: "loading"; readonly result: SourceControlDiscoveryResult | null }
  | { readonly status: "ready"; readonly result: SourceControlDiscoveryResult }
  | {
      readonly status: "error";
      readonly result: SourceControlDiscoveryResult | null;
      readonly message: string;
    };

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function statusPresentation(item: SourceControlDiscoveryItem): {
  readonly label: string;
  readonly badge: "success" | "warning" | "outline";
  readonly dot: string;
} {
  if (item.implemented && item.status === "available") {
    return {
      label: "Ready",
      badge: "success",
      dot: "bg-success",
    };
  }
  if (item.implemented) {
    return {
      label: "CLI missing",
      badge: "warning",
      dot: "bg-warning",
    };
  }
  if (item.status === "available") {
    return {
      label: "Detected",
      badge: "outline",
      dot: "bg-muted-foreground/60",
    };
  }
  return {
    label: "Placeholder",
    badge: "outline",
    dot: "bg-muted-foreground/40",
  };
}

function DiscoveryItemRow({
  item,
  expanded,
  onExpandedChange,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const status = statusPresentation(item);
  const version = optionLabel(item.version);
  const detail = optionLabel(item.detail);
  const enabled = item.implemented && item.status === "available";

  return (
    <div
      className={cn(
        "border-t border-border/60 first:border-t-0",
        !item.implemented && "opacity-80",
      )}
    >
      <div className="px-4 py-3.5 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={cn("size-2 rounded-full", status.dot)} aria-hidden />
              <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                {item.label}
              </h3>
              <Badge variant={status.badge} size="sm">
                {status.label}
              </Badge>
              {!item.implemented ? (
                <Badge variant="outline" size="sm">
                  Not in this branch
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              <span>CLI</span>
              <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80">
                {item.executable}
              </code>
              {version ? <span>- {version}</span> : null}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onExpandedChange(!expanded)}
              aria-label={`Toggle ${item.label} details`}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
              />
            </Button>
            <Switch checked={enabled} disabled aria-label={`${item.label} availability`} />
          </div>
        </div>
      </div>

      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="border-t border-border/60 px-4 py-3 text-xs sm:px-5">
            <dl className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Command</dt>
              <dd className="min-w-0 font-mono text-foreground">{item.executable}</dd>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="min-w-0 text-foreground">{version ?? "Not detected"}</dd>
              <dt className="text-muted-foreground">Install</dt>
              <dd className="min-w-0 leading-relaxed text-foreground">{item.installHint}</dd>
              <dt className="text-muted-foreground">Build</dt>
              <dd className="min-w-0 leading-relaxed text-foreground">
                {item.implemented
                  ? "Enabled in this branch and available for repository routing when the CLI is present."
                  : "Placeholder only in this branch. The matching driver/provider PR enables this row."}
              </dd>
              {detail ? (
                <>
                  <dt className="text-muted-foreground">Probe</dt>
                  <dd className="min-w-0 break-words text-muted-foreground">{detail}</dd>
                </>
              ) : null}
            </dl>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function SourceControlSettingsPanel() {
  const [loadState, setLoadState] = useState<DiscoveryLoadState>({
    status: "loading",
    result: null,
  });
  const latestResultRef = useRef<SourceControlDiscoveryResult | null>(null);
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});

  const refresh = useCallback((options?: { readonly signal?: AbortSignal }) => {
    const previous = latestResultRef.current;
    setLoadState({ status: "loading", result: previous });

    ensureLocalApi()
      .server.discoverSourceControl()
      .then((result) => {
        if (!options?.signal?.aborted) {
          latestResultRef.current = result;
          setLoadState({ status: "ready", result });
        }
      })
      .catch((cause: unknown) => {
        if (!options?.signal?.aborted) {
          setLoadState({
            status: "error",
            result: previous,
            message:
              cause instanceof Error ? cause.message : "Failed to discover source control tools.",
          });
        }
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh({ signal: controller.signal });
    return () => controller.abort();
  }, [refresh]);

  const result = loadState.result ?? EMPTY_DISCOVERY_RESULT;
  const statusText = useMemo(() => {
    if (loadState.status === "loading") return "Scanning installed tools...";
    if (loadState.status === "error") return loadState.message;
    return "Detected source control tools on this system.";
  }, [loadState]);

  const setItemExpanded = (key: string, value: boolean) => {
    setExpanded((current) => ({ ...current, [key]: value }));
  };

  return (
    <SettingsPageContainer>
      <div className="space-y-1 px-1">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Source Control</h1>
        <p className="text-sm text-muted-foreground">{statusText}</p>
      </div>

      <SettingsSection
        title="Version Control"
        icon={<GitBranchIcon className="size-3.5" />}
        headerAction={
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => refresh()}
            disabled={loadState.status === "loading"}
          >
            <RefreshCwIcon
              className={cn("size-3.5", loadState.status === "loading" && "animate-spin")}
            />
            Scan
          </Button>
        }
      >
        {result.versionControlSystems.map((item) => (
          <DiscoveryItemRow
            key={`vcs:${item.kind}`}
            item={item}
            expanded={expanded[`vcs:${item.kind}`] ?? false}
            onExpandedChange={(value) => setItemExpanded(`vcs:${item.kind}`, value)}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Source Control Providers"
        icon={<GitPullRequestIcon className="size-3.5" />}
      >
        {result.sourceControlProviders.map((item) => (
          <DiscoveryItemRow
            key={`provider:${item.kind}`}
            item={item}
            expanded={expanded[`provider:${item.kind}`] ?? false}
            onExpandedChange={(value) => setItemExpanded(`provider:${item.kind}`, value)}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

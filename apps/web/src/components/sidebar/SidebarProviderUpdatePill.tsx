import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider } from "@t3tools/contracts";
import { CircleCheckIcon, DownloadIcon, LoaderIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { primaryServerProvidersAtom } from "../../state/server";
import {
  getProviderUpdateSidebarPillView,
  type ProviderUpdateSidebarPillView,
} from "../ProviderUpdateLaunchNotification.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PROVIDER_UPDATE_PILL_STYLES = {
  loading:
    "bg-primary/15 text-primary group-has-[button.provider-update-main:hover]/provider-update:bg-primary/22",
  success:
    "bg-success/12 text-success group-has-[button.provider-update-main:hover]/provider-update:bg-success/18",
  warning:
    "bg-warning/12 text-warning group-has-[button.provider-update-main:hover]/provider-update:bg-warning/18",
  error:
    "bg-destructive/12 text-destructive group-has-[button.provider-update-main:hover]/provider-update:bg-destructive/18",
} as const;

const PROVIDER_UPDATE_PILL_PROGRESS_STYLES = {
  success: "bg-success/18",
  warning: "bg-warning/14",
  error: "bg-destructive/14",
} as const;

function latestProviderCheckedAt(
  providers: ReadonlyArray<Pick<ServerProvider, "checkedAt">>,
): string | undefined {
  return providers.reduce<string | undefined>(
    (latest, provider) =>
      latest === undefined || provider.checkedAt > latest ? provider.checkedAt : latest,
    undefined,
  );
}

interface SidebarProviderUpdatePillContentProps {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onOpenProviderSettings: () => void;
}

interface ProviderUpdatePillExitState {
  readonly view: ProviderUpdateSidebarPillView;
  readonly dismissAfterExitKey: string | null;
}

function useProviderUpdatePillAutoDismiss({
  displayedView,
  exitingKey,
  startExit,
}: {
  readonly displayedView: ProviderUpdateSidebarPillView | null;
  readonly exitingKey: string | null;
  readonly startExit: (view: ProviderUpdateSidebarPillView, dismissKey?: string) => void;
}) {
  const dismissAfterVisibleMs = displayedView?.dismissAfterVisibleMs;
  const viewKey = displayedView?.key ?? null;

  useEffect(() => {
    if (!displayedView || !dismissAfterVisibleMs || !viewKey) {
      return;
    }
    if (exitingKey === viewKey) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      startExit(displayedView, viewKey);
    }, dismissAfterVisibleMs);

    return () => window.clearTimeout(timeoutId);
  }, [dismissAfterVisibleMs, displayedView, exitingKey, startExit, viewKey]);
}

export function SidebarProviderUpdatePill() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const openProviderSettings = useCallback(() => {
    void navigate({ to: "/settings/providers" });
  }, [navigate]);

  if (providers.length === 0) {
    return null;
  }

  return (
    <SidebarProviderUpdatePillContent
      providers={providers}
      onOpenProviderSettings={openProviderSettings}
    />
  );
}

export function SidebarProviderUpdatePillContent({
  providers,
  onOpenProviderSettings,
}: SidebarProviderUpdatePillContentProps) {
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleAfterIso] = useState(() => latestProviderCheckedAt(providers));
  const view = getProviderUpdateSidebarPillView(providers, {
    ...(visibleAfterIso !== undefined ? { visibleAfterIso } : {}),
    dismissedKeys,
  });
  const [exitState, setExitState] = useState<ProviderUpdatePillExitState | null>(null);
  const displayedView = exitState?.view ?? view;
  const exitingKey = exitState?.view.key ?? null;
  const dismissAfterVisibleMs = displayedView?.dismissAfterVisibleMs;
  const viewKey = displayedView?.key ?? null;
  const showDismissProgress =
    dismissAfterVisibleMs !== undefined &&
    displayedView?.tone !== "loading" &&
    exitingKey !== viewKey;

  const startExit = useCallback((exitView: ProviderUpdateSidebarPillView, dismissKey?: string) => {
    setExitState((current) =>
      current?.view.key === exitView.key
        ? current
        : { view: exitView, dismissAfterExitKey: dismissKey ?? null },
    );
  }, []);

  useProviderUpdatePillAutoDismiss({ displayedView, exitingKey, startExit });

  if (!displayedView) {
    return null;
  }

  return (
    <div
      className={`group/provider-update relative flex h-7 w-full items-center overflow-hidden rounded-lg text-xs font-medium transform-gpu transition-all duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${
        PROVIDER_UPDATE_PILL_STYLES[displayedView.tone]
      } ${
        exitingKey === displayedView.key
          ? "pointer-events-none translate-y-1.5 opacity-0"
          : "translate-y-0 opacity-100"
      }`}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (!displayedView || exitingKey !== displayedView.key) {
          return;
        }
        if (exitState?.dismissAfterExitKey === displayedView.key) {
          setDismissedKeys((previous) => new Set(previous).add(displayedView.key));
        }
        setExitState(null);
      }}
    >
      {showDismissProgress ? (
        <div
          key={displayedView.key}
          aria-hidden="true"
          className={`provider-update-pill-progress pointer-events-none absolute inset-y-0 left-0 w-full origin-left border-r border-current/15 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)] ${
            PROVIDER_UPDATE_PILL_PROGRESS_STYLES[displayedView.tone]
          }`}
          style={
            {
              "--provider-update-pill-dismiss-ms": `${dismissAfterVisibleMs}ms`,
            } as CSSProperties
          }
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 rounded-lg transition-colors" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={displayedView.description}
              className="provider-update-main relative z-[1] flex h-full flex-1 items-center gap-2 px-2 text-left"
              onClick={onOpenProviderSettings}
            >
              {displayedView.tone === "loading" ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : displayedView.tone === "success" ? (
                <CircleCheckIcon className="size-3.5" />
              ) : displayedView.tone === "error" ? (
                <TriangleAlertIcon className="size-3.5" />
              ) : (
                <DownloadIcon className="size-3.5" />
              )}
              <span>{displayedView.title}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{displayedView.description}</TooltipPopup>
      </Tooltip>
      {displayedView.dismissible && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss provider update notice"
                className="relative z-[1] mr-1 inline-flex size-5 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100"
                onClick={() => startExit(displayedView, displayedView.key)}
              >
                <XIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="top">Dismiss until provider status changes</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

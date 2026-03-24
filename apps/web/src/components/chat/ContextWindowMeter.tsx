import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function ringStyle(usage: ContextWindowSnapshot): CSSProperties {
  const percentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const tone =
    percentage >= 90
      ? "var(--color-rose-500)"
      : percentage >= 75
        ? "var(--color-amber-500)"
        : "var(--color-foreground)";

  return {
    backgroundImage:
      usage.usedPercentage === null
        ? "linear-gradient(var(--color-muted), var(--color-muted))"
        : `conic-gradient(${tone} ${percentage}%, color-mix(in oklab, var(--color-muted) 70%, transparent) 0)`,
  };
}

export function ContextWindowMeter(props: { usage: ContextWindowSnapshot }) {
  const { usage } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span
              className="relative flex h-6 w-6 items-center justify-center rounded-full p-[2px]"
              style={ringStyle(usage)}
            >
              <span
                className={cn(
                  "flex h-full w-full items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  usage.usedPercentage !== null && usage.usedPercentage >= 90
                    ? "text-rose-500"
                    : usage.usedPercentage !== null && usage.usedPercentage >= 75
                      ? "text-amber-500"
                      : "text-muted-foreground",
                )}
              >
                {usage.usedPercentage !== null
                  ? Math.round(usage.usedPercentage)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </button>
        }
      />
      <TooltipPopup side="top" align="end" className="max-w-72 whitespace-normal px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Context window
          </div>
          {usage.maxTokens !== null && usedPercentage ? (
            <div className="text-xs font-medium text-foreground">
              <span>{usedPercentage}</span>
              <span className="mx-1">⋅</span>
              <span>{formatContextWindowTokens(usage.usedTokens)}</span>
              <span>/</span>
              <span>{formatContextWindowTokens(usage.maxTokens ?? null)} context used</span>
            </div>
          ) : (
            <div className="text-sm text-foreground">
              {formatContextWindowTokens(usage.usedTokens)} tokens used so far
            </div>
          )}
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-xs text-muted-foreground">
              Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
              tokens
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

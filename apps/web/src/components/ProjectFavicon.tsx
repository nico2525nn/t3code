import { useAtomValue } from "@effect/atom-react";
import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";
import {
  forgetProjectFavicon,
  getRememberedProjectFavicon,
  planProjectFaviconRender,
  projectFaviconMemoryVersion,
  rememberProjectFavicon,
  subscribeProjectFaviconMemory,
} from "@t3tools/client-runtime/state/project-favicon";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useState, useSyncExternalStore } from "react";
import { useAssetUrlState } from "../assets/assetUrls";
import { projectFaviconSourcesAtom } from "~/state/projects";
import { cn } from "~/lib/utils";

const loadedProjectFaviconSrcs = new Map<string, string>();

/**
 * Renders a project's icon by repository identity: every row of a repo group
 * asks the same source environment for the same file, the last loaded icon is
 * remembered for the session so a dropped connection never blanks it, and the
 * row's own environment is the last resort before the folder glyph.
 */
export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  faviconPath?: string | null | undefined;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const physicalKey = derivePhysicalProjectKeyFromPath(input.environmentId, input.cwd);
  const source = useAtomValue(projectFaviconSourcesAtom).get(physicalKey) ?? null;
  const iconKey = source?.iconKey ?? physicalKey;
  const sourceState = useProjectFaviconAsset({
    environmentId: source?.environmentId ?? input.environmentId,
    cwd: source?.cwd ?? input.cwd,
    faviconPath: source ? source.faviconPath : input.faviconPath,
  });
  const ownState = useProjectFaviconAsset(input);
  useSyncExternalStore(subscribeProjectFaviconMemory, projectFaviconMemoryVersion);

  const liveOf = (
    state: ReturnType<typeof useProjectFaviconAsset>,
    environmentId: EnvironmentId,
    cwd: string,
  ) =>
    state._tag === "Success" && !isProjectFaviconFallbackUrl(state.url)
      ? { url: state.url, cacheKey: getProjectFaviconCacheKey(environmentId, cwd, state.url) }
      : null;
  const plan = planProjectFaviconRender({
    sourceLive: liveOf(
      sourceState,
      source?.environmentId ?? input.environmentId,
      source?.cwd ?? input.cwd,
    ),
    ownLive: liveOf(ownState, input.environmentId, input.cwd),
    remembered: getRememberedProjectFavicon(iconKey),
  });
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;

  if (plan === null) {
    return <ProjectFaviconFallback className={input.className} icon={FallbackIcon} />;
  }

  return (
    <ProjectFaviconImage
      key={plan.cacheKey}
      cacheKey={plan.cacheKey}
      iconKey={iconKey}
      src={plan.url}
      remember={plan.remember}
      className={input.className}
      fallbackIcon={FallbackIcon}
    />
  );
}

export function useProjectFaviconAsset(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}) {
  return useAssetUrlState(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
    ...(input.faviconPath ? { path: input.faviconPath } : {}),
  });
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}

function ProjectFaviconImage({
  cacheKey,
  iconKey,
  src,
  remember,
  className,
  fallbackIcon: FallbackIcon,
}: {
  readonly cacheKey: string;
  readonly iconKey: string;
  readonly src: string;
  readonly remember: boolean;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedProjectFaviconSrcs.get(cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedProjectFaviconSrcs.get(cacheKey) === failedSrc) {
      loadedProjectFaviconSrcs.delete(cacheKey);
    }
    forgetProjectFavicon(iconKey, failedSrc);
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };
  const handleLoad = () => {
    loadedProjectFaviconSrcs.set(cacheKey, src);
    if (remember) {
      rememberProjectFavicon(iconKey, { url: src, cacheKey });
    }
    setDisplayedSrc(src);
  };

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback className={className} icon={FallbackIcon} />
      ) : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={handleLoad}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}

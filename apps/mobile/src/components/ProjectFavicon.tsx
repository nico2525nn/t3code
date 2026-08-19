import { SymbolView } from "./AppSymbol";
import { useAtomValue } from "@effect/atom-react";
import { Image } from "expo-image";
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";
import {
  forgetProjectFavicon,
  getRememberedProjectFavicon,
  planProjectFaviconRender,
  projectFaviconMemoryVersion,
  rememberProjectFavicon,
  subscribeProjectFaviconMemory,
} from "@t3tools/client-runtime/state/project-favicon";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { useThemeColor } from "../lib/useThemeColor";
import { useAssetUrl } from "../state/assets";
import { projectFaviconSourcesAtom } from "../state/projects";
import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  hasLoadedProjectFavicon,
  markProjectFaviconFailed,
  markProjectFaviconLoaded,
} from "./projectFaviconCache";

/* ─── Component ──────────────────────────────────────────────────────── */
/**
 * Renders a project's icon by repository identity: every row of a repo group
 * asks the same source environment for the same file, the last loaded icon is
 * remembered for the session so a dropped connection never blanks it, and the
 * row's own environment is the last resort before the folder glyph.
 */
export function ProjectFavicon(props: {
  readonly environmentId: EnvironmentId;
  readonly open?: boolean;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
  readonly faviconPath?: string | null;
}) {
  const size = props.size ?? 42;
  const workspaceRoot = props.workspaceRoot ?? null;
  const physicalKey =
    workspaceRoot === null
      ? null
      : derivePhysicalProjectKeyFromPath(props.environmentId, workspaceRoot);
  const faviconSources = useAtomValue(projectFaviconSourcesAtom);
  const source = (physicalKey === null ? null : faviconSources.get(physicalKey)) ?? null;
  const iconKey = source?.iconKey ?? physicalKey;

  const faviconResource = (cwd: string, faviconPath: string | null) =>
    ({
      _tag: "project-favicon",
      cwd,
      ...(faviconPath ? { path: faviconPath } : {}),
    }) as const;
  const sourceUrl = useAssetUrl(
    source?.environmentId ?? props.environmentId,
    workspaceRoot === null
      ? null
      : faviconResource(
          source?.cwd ?? workspaceRoot,
          source ? source.faviconPath : (props.faviconPath ?? null),
        ),
  );
  const ownUrl = useAssetUrl(
    props.environmentId,
    workspaceRoot === null ? null : faviconResource(workspaceRoot, props.faviconPath ?? null),
  );
  useSyncExternalStore(subscribeProjectFaviconMemory, projectFaviconMemoryVersion);

  const liveOf = (url: string | null, environmentId: EnvironmentId, cwd: string | null) =>
    url !== null && cwd !== null && !isProjectFaviconFallbackUrl(url)
      ? { url, cacheKey: getProjectFaviconCacheKey(environmentId, cwd, url) }
      : null;
  const plan = planProjectFaviconRender({
    sourceLive: liveOf(
      sourceUrl,
      source?.environmentId ?? props.environmentId,
      source?.cwd ?? workspaceRoot,
    ),
    ownLive: liveOf(ownUrl, props.environmentId, workspaceRoot),
    remembered: iconKey === null ? null : getRememberedProjectFavicon(iconKey),
  });

  return (
    <ProjectFaviconImage
      key={plan?.cacheKey ?? null}
      cacheKey={plan?.cacheKey ?? null}
      iconKey={iconKey}
      faviconUrl={plan?.url ?? null}
      remember={plan?.remember ?? false}
      open={props.open}
      projectTitle={props.projectTitle}
      size={size}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly cacheKey: string | null;
  readonly iconKey: string | null;
  readonly faviconUrl: string | null;
  readonly remember: boolean;
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const iconMuted = useThemeColor("--color-icon-subtle");
  const faviconRequest = useMemo(
    () => createProjectFaviconRequest(props.cacheKey, props.faviconUrl),
    [props.cacheKey, props.faviconUrl],
  );
  const [activeFaviconRequest, setActiveFaviconRequest] = useState<typeof faviconRequest>(null);
  useLayoutEffect(() => {
    if (faviconRequest === null) return;

    const endRequest = beginProjectFaviconRequest(faviconRequest);
    setActiveFaviconRequest(faviconRequest);
    return endRequest;
  }, [faviconRequest]);

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    hasLoadedProjectFavicon(props.cacheKey) ? "loaded" : "loading",
  );

  const requestIsActive = faviconRequest !== null && activeFaviconRequest === faviconRequest;
  const showImage = requestIsActive && status === "loaded";

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Folder icon fallback (matches web's FolderIcon) */}
      {!showImage ? (
        <SymbolView
          name={{ ios: "folder.fill", android: props.open ? "folder_open" : "folder" }}
          size={props.size * 0.78}
          tintColor={iconMuted}
          type="monochrome"
        />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {requestIsActive ? (
        <Image
          key={faviconRequest.faviconUrl}
          source={{
            uri: faviconRequest.faviconUrl,
            cacheKey: faviconRequest.cacheKey,
          }}
          cachePolicy="memory-disk"
          recyclingKey={faviconRequest.cacheKey}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          onLoad={() => {
            if (!markProjectFaviconLoaded(faviconRequest)) return;
            if (props.remember && props.iconKey !== null) {
              rememberProjectFavicon(props.iconKey, {
                url: faviconRequest.faviconUrl,
                cacheKey: faviconRequest.cacheKey,
              });
            }
            setStatus("loaded");
          }}
          onError={() => {
            if (!markProjectFaviconFailed(faviconRequest)) return;
            if (props.iconKey !== null) {
              forgetProjectFavicon(props.iconKey, faviconRequest.faviconUrl);
            }
            setStatus("error");
          }}
        />
      ) : null}
    </View>
  );
}

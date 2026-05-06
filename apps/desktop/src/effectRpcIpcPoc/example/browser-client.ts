import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { Cause, Effect, Option, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import {
  getEffectElectronIpcRendererBridge,
  makeEffectElectronIpcRendererPort,
  makeEffectElectronIpcRendererProtocol,
  type EffectElectronIpcBrowserGlobal,
} from "effect-electron-ipc/client";
import type { EffectElectronIpcRendererBridge } from "effect-electron-ipc/ipc";
import {
  DESKTOP_IPC_POC_METHODS,
  makeDesktopIpcPocClient,
  type DesktopIpcPocClient,
  type DesktopIpcPocEchoResult,
  type DesktopIpcPocRuntimeInfo,
  type DesktopIpcPocTick,
} from "./protocol.ts";

// -----------------------------------------------------------------------------
// example/preload.ts
// -----------------------------------------------------------------------------
// The real preload file is intentionally tiny:
//
//   import { contextBridge, ipcRenderer } from "electron";
//   import { exposeEffectElectronIpcPreloadBridge } from "effect-electron-ipc/preload";
//
//   exposeEffectElectronIpcPreloadBridge({ contextBridge, ipcRenderer });
//
// That installs `window.effectElectronIpc`, which this browser module reads below.

// -----------------------------------------------------------------------------
// example/browser-react-runtime.ts
// -----------------------------------------------------------------------------
// These declarations stand in for the actual React and @effect/atom-react imports
// a renderer bundle would use. The transport and Effect RPC client code below is
// real; only the UI runtime host is declared to keep this proof of concept small.

type ReactElement = unknown;
type ReactNode = unknown;
type ReactComponent<P extends object = Record<string, never>> = (props: P) => ReactElement;
type ReactElementType<P extends object = Record<string, never>> = string | ReactComponent<P>;

declare const React: {
  readonly createElement: <P extends object>(
    type: ReactElementType<P>,
    props?: P | null,
    ...children: ReactNode[]
  ) => ReactElement;
};

declare const createRoot: (container: Element) => {
  readonly render: (element: ReactElement) => void;
};

declare const useAtomRefresh: <A>(atom: Atom.Atom<A>) => () => void;
declare const useAtomValue: <A>(atom: Atom.Atom<A>) => A;

// -----------------------------------------------------------------------------
// example/protocol.ts
// -----------------------------------------------------------------------------
// The shared RPC contract lives in protocol.ts. Both the Electron main process
// and browser renderer import this contract, so the renderer gets a typed client
// without depending on Electron-specific implementation code.

export interface DesktopIpcPocSnapshot {
  readonly runtimeInfo: DesktopIpcPocRuntimeInfo;
  readonly echo: DesktopIpcPocEchoResult;
  readonly ticks: ReadonlyArray<DesktopIpcPocTick>;
}

// -----------------------------------------------------------------------------
// example/browser-client.ts
// -----------------------------------------------------------------------------
// This is the important browser-side transport step:
//
//   preload bridge -> Effect Electron IPC renderer port
//                  -> Effect RPC RpcClient.Protocol
//                  -> typed DesktopIpcPocClient

export interface DesktopIpcPocBrowserClientOptions {
  readonly bridge?: EffectElectronIpcRendererBridge;
  readonly globalObject?: EffectElectronIpcBrowserGlobal;
}

export interface DesktopIpcPocSnapshotOptions extends DesktopIpcPocBrowserClientOptions {
  readonly echoText?: string;
  readonly ticks?: number;
}

export const makeDesktopIpcPocBrowserClient = (
  options: DesktopIpcPocBrowserClientOptions = {},
): Effect.Effect<DesktopIpcPocClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const bridge = options.bridge ?? getEffectElectronIpcRendererBridge(options.globalObject);
    const rendererPort = makeEffectElectronIpcRendererPort(bridge);
    const rendererProtocol = yield* makeEffectElectronIpcRendererProtocol(rendererPort);

    return yield* makeDesktopIpcPocClient.pipe(
      Effect.provideService(RpcClient.Protocol, rendererProtocol),
    );
  });

export const loadDesktopIpcPocSnapshot = (
  options: DesktopIpcPocSnapshotOptions = {},
): Effect.Effect<DesktopIpcPocSnapshot, RpcClientError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* makeDesktopIpcPocBrowserClient(options);
    const runtimeInfo = yield* client[DESKTOP_IPC_POC_METHODS.getRuntimeInfo]({});
    const echo = yield* client[DESKTOP_IPC_POC_METHODS.echo]({
      text: options.echoText ?? "hello from the renderer",
    });
    const ticks = yield* client[DESKTOP_IPC_POC_METHODS.subscribeTicks]({
      take: options.ticks ?? 3,
    }).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

    return {
      runtimeInfo,
      echo,
      ticks,
    };
  });

export const loadDesktopIpcPocSnapshotFromBrowser = (
  options: Omit<DesktopIpcPocSnapshotOptions, "bridge" | "globalObject"> = {},
) => Effect.runPromise(Effect.scoped(loadDesktopIpcPocSnapshot(options)));

// -----------------------------------------------------------------------------
// example/browser-atoms.ts
// -----------------------------------------------------------------------------
// These are the Effect Atom values the React layer consumes. The labels and SWR
// annotations are the important bit for app ergonomics: the RPC client and RPC
// query have stable, inspectable identities and refresh behavior.

const DESKTOP_IPC_POC_SNAPSHOT_STALE_TIME_MS = 5_000;
const DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS = 60_000;

export const desktopIpcPocClientAtom = Atom.make(makeDesktopIpcPocBrowserClient()).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop-ipc-poc:effect-rpc-client"),
);

export const desktopIpcPocSnapshotAtom = Atom.make(
  loadDesktopIpcPocSnapshot({
    echoText: "hello from an Effect Atom",
    ticks: 5,
  }),
).pipe(
  Atom.swr({
    staleTime: DESKTOP_IPC_POC_SNAPSHOT_STALE_TIME_MS,
    revalidateOnMount: true,
  }),
  Atom.setIdleTTL(DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS),
  Atom.withLabel("desktop-ipc-poc:snapshot"),
);

export const desktopIpcPocManualEchoAtom = Atom.make(
  Effect.gen(function* () {
    const client = yield* makeDesktopIpcPocBrowserClient();
    return yield* client[DESKTOP_IPC_POC_METHODS.echo]({
      text: "manual echo from an Atom-backed action",
    });
  }),
).pipe(Atom.withLabel("desktop-ipc-poc:manual-echo"));

// -----------------------------------------------------------------------------
// example/components/DesktopIpcPocPanel.tsx
// -----------------------------------------------------------------------------
// The React layer does not know about Electron IPC or RpcClient.Protocol. It only
// reads Atom values, renders AsyncResult states, and calls Atom refresh handlers.

function formatAsyncResultError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") {
    return null;
  }
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : String(error);
}

function DesktopIpcPocClientStatus(): ReactElement {
  const clientResult = useAtomValue(desktopIpcPocClientAtom);
  const isReady = clientResult._tag === "Success";
  const label = isReady
    ? "Effect RPC client ready"
    : clientResult.waiting
      ? "Connecting RPC client"
      : "RPC client failed";

  return React.createElement(
    "span",
    {
      "data-state": isReady ? "ready" : clientResult._tag.toLowerCase(),
    },
    label,
  );
}

function RuntimeInfoView(props: { readonly runtimeInfo: DesktopIpcPocRuntimeInfo }): ReactElement {
  return React.createElement(
    "dl",
    { "aria-label": "Runtime info" },
    React.createElement("dt", null, "App version"),
    React.createElement("dd", null, props.runtimeInfo.appVersion),
    React.createElement("dt", null, "Platform"),
    React.createElement("dd", null, props.runtimeInfo.platform),
    React.createElement("dt", null, "Transport"),
    React.createElement("dd", null, props.runtimeInfo.ipcTransport),
  );
}

function EchoView(props: { readonly echo: DesktopIpcPocEchoResult }): ReactElement {
  return React.createElement("p", null, `Echoed "${props.echo.text}" at ${props.echo.echoedAt}`);
}

function TickList(props: { readonly ticks: ReadonlyArray<DesktopIpcPocTick> }): ReactElement {
  return React.createElement(
    "ol",
    { "aria-label": "Streamed ticks" },
    ...props.ticks.map((tick) =>
      React.createElement("li", { key: tick.sequence }, `${tick.sequence}: ${tick.label}`),
    ),
  );
}

export function DesktopIpcPocPanel(): ReactElement {
  const snapshotResult = useAtomValue(desktopIpcPocSnapshotAtom);
  const refreshSnapshot = useAtomRefresh(desktopIpcPocSnapshotAtom);
  const snapshot = Option.getOrNull(AsyncResult.value(snapshotResult));
  const error = formatAsyncResultError(snapshotResult);

  return React.createElement(
    "section",
    { "aria-label": "Effect Electron IPC proof of concept" },
    React.createElement("header", null, React.createElement(DesktopIpcPocClientStatus, null)),
    React.createElement(
      "button",
      {
        disabled: snapshotResult.waiting,
        onClick: refreshSnapshot,
        type: "button",
      },
      snapshotResult.waiting ? "Refreshing" : "Refresh",
    ),
    error ? React.createElement("p", { role: "alert" }, error) : null,
    snapshot
      ? React.createElement(
          "div",
          null,
          React.createElement(RuntimeInfoView, { runtimeInfo: snapshot.runtimeInfo }),
          React.createElement(EchoView, { echo: snapshot.echo }),
          React.createElement(TickList, { ticks: snapshot.ticks }),
        )
      : React.createElement("p", null, "Loading desktop RPC data"),
  );
}

// -----------------------------------------------------------------------------
// example/renderer.tsx
// -----------------------------------------------------------------------------
// The renderer entrypoint just mounts the React tree. The preload has already
// installed the bridge, and the Atom graph lazily creates the Effect RPC client.

export function mountDesktopIpcPocReactExample(container: Element): void {
  createRoot(container).render(React.createElement(DesktopIpcPocPanel, null));
}

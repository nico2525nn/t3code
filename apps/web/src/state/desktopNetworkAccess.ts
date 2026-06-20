import type {
  AdvertisedEndpoint,
  DesktopBridge,
  DesktopServerExposureState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const DESKTOP_NETWORK_ACCESS_STALE_TIME_MS = 30_000;

type DesktopNetworkAccessBridge = Pick<
  DesktopBridge,
  "getAdvertisedEndpoints" | "getServerExposureState"
>;

export interface DesktopNetworkAccessSnapshot {
  readonly advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly serverExposureState: DesktopServerExposureState;
}

export class DesktopNetworkAccessUnavailableError extends Schema.TaggedErrorClass<DesktopNetworkAccessUnavailableError>()(
  "DesktopNetworkAccessUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop network access is unavailable.";
  }
}

export class DesktopNetworkAccessLoadError extends Schema.TaggedErrorClass<DesktopNetworkAccessLoadError>()(
  "DesktopNetworkAccessLoadError",
  {
    operation: Schema.Literals(["get-advertised-endpoints", "get-server-exposure-state"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop network access operation '${this.operation.replaceAll("-", " ")}' failed.`;
  }
}

export const DesktopNetworkAccessError = Schema.Union([
  DesktopNetworkAccessUnavailableError,
  DesktopNetworkAccessLoadError,
]);
export type DesktopNetworkAccessError = typeof DesktopNetworkAccessError.Type;

function getDesktopNetworkAccessBridge(): DesktopNetworkAccessBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopNetworkAccessStateAtom(
  getBridge: () => DesktopNetworkAccessBridge | undefined,
) {
  const loadDesktopNetworkAccess = Effect.fn("loadDesktopNetworkAccess")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopNetworkAccessUnavailableError();
    }
    const { serverExposureState, advertisedEndpoints } = yield* Effect.all(
      {
        serverExposureState: Effect.tryPromise({
          try: () => bridge.getServerExposureState(),
          catch: (cause) =>
            new DesktopNetworkAccessLoadError({
              operation: "get-server-exposure-state",
              cause,
            }),
        }),
        advertisedEndpoints: Effect.tryPromise({
          try: () => bridge.getAdvertisedEndpoints(),
          catch: (cause) =>
            new DesktopNetworkAccessLoadError({
              operation: "get-advertised-endpoints",
              cause,
            }),
        }),
      },
      { concurrency: "unbounded" },
    );
    return { advertisedEndpoints, serverExposureState };
  });

  return Atom.make(loadDesktopNetworkAccess()).pipe(
    Atom.swr({
      staleTime: DESKTOP_NETWORK_ACCESS_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:network-access"),
  );
}

export const desktopNetworkAccessStateAtom = createDesktopNetworkAccessStateAtom(
  getDesktopNetworkAccessBridge,
);

export function refreshDesktopNetworkAccessState(): void {
  appAtomRegistry.refresh(desktopNetworkAccessStateAtom);
}

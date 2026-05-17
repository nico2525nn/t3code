import { DesktopWslStateSchema, type DesktopWslState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslBackend from "../../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const readWslState: Effect.Effect<
  DesktopWslState,
  never,
  DesktopAppSettings.DesktopAppSettings | DesktopWslEnvironment.DesktopWslEnvironment
> = Effect.gen(function* () {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const settings = yield* appSettings.get;
  const available = yield* wslEnvironment.isAvailable;
  // Only enumerate distros when WSL is actually available — listDistros on a
  // non-WSL host would spawn wsl.exe and hit the timeout for nothing.
  const distros = available ? yield* wslEnvironment.listDistros : [];
  return {
    enabled: settings.wslBackendEnabled,
    distro: settings.wslDistro,
    available,
    distros,
  };
});

export const getWslState = makeIpcMethod({
  channel: IpcChannels.GET_WSL_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWslStateSchema,
  handler: Effect.fn("desktop.ipc.wsl.getState")(function* () {
    return yield* readWslState;
  }),
});

export const setWslBackendEnabled = makeIpcMethod({
  channel: IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopWslStateSchema,
  handler: Effect.fn("desktop.ipc.wsl.setEnabled")(function* (enabled) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;
    yield* appSettings.setWslBackendEnabled(enabled);
    // Reconcile is idempotent and never fails; no need for a swap-style
    // rollback when the WSL side has trouble coming up. With both
    // backends running side by side, "WSL didn't start" is a transient
    // state on one instance — the primary stays up either way.
    yield* wslBackend.reconcile;
    return yield* readWslState;
  }),
});

export const setWslDistro = makeIpcMethod({
  channel: IpcChannels.SET_WSL_DISTRO_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: DesktopWslStateSchema,
  handler: Effect.fn("desktop.ipc.wsl.setDistro")(function* (distro) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;
    yield* appSettings.setWslDistro(distro);
    yield* wslBackend.reconcile;
    return yield* readWslState;
  }),
});

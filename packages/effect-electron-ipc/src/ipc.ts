import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

/**
 * Shared IPC envelope for the Electron transport.
 *
 * Electron IPC already gives us framing and structured clone, so the transport
 * can pass Effect RPC's encoded message objects directly instead of wrapping
 * them in JSON-RPC text.
 */

export const EFFECT_ELECTRON_IPC_CHANNELS = {
  rendererToMain: "effect-electron-ipc:renderer-to-main",
  mainToRenderer: "effect-electron-ipc:main-to-renderer",
} as const;

export const EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY = "effectElectronIpc" as const;

export interface EffectElectronIpcRendererFrame {
  readonly version: 1;
  readonly rendererClientId: number;
  readonly message: FromClientEncoded;
}

export interface EffectElectronIpcMainFrame {
  readonly version: 1;
  readonly rendererClientId: number;
  readonly message: FromServerEncoded;
}

export interface EffectElectronIpcRendererPort {
  readonly send: (frame: EffectElectronIpcRendererFrame) => void;
  readonly subscribe: (listener: (frame: EffectElectronIpcMainFrame) => void) => () => void;
}

export type EffectElectronIpcRendererBridge = EffectElectronIpcRendererPort;

export interface EffectElectronIpcMainSource {
  readonly id: number;
  readonly send: (frame: EffectElectronIpcMainFrame) => void;
  readonly isClosed?: () => boolean;
  readonly onClose?: (listener: () => void) => () => void;
}

export interface EffectElectronIpcMainPort {
  readonly subscribe: (
    listener: (source: EffectElectronIpcMainSource, frame: EffectElectronIpcRendererFrame) => void,
  ) => () => void;
}

export function isEffectElectronIpcRendererFrame(
  value: unknown,
): value is EffectElectronIpcRendererFrame {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.rendererClientId === "number" &&
    isRecord(value.message)
  );
}

export function isEffectElectronIpcMainFrame(value: unknown): value is EffectElectronIpcMainFrame {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.rendererClientId === "number" &&
    isRecord(value.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

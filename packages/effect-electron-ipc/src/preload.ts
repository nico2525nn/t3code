import {
  EFFECT_ELECTRON_IPC_CHANNELS,
  EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY,
  type EffectElectronIpcRendererBridge,
  type EffectElectronIpcRendererFrame,
  isEffectElectronIpcMainFrame,
  isEffectElectronIpcRendererFrame,
} from "./ipc.ts";

export interface ElectronLikeIpcRenderer {
  readonly send: (channel: string, frame: EffectElectronIpcRendererFrame) => void;
  readonly on: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
  readonly off?: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
  readonly removeListener?: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
}

export interface ElectronLikeContextBridge {
  readonly exposeInMainWorld: (apiKey: string, api: EffectElectronIpcRendererBridge) => void;
}

export function makeEffectElectronIpcPreloadBridge(
  electronIpcRenderer: ElectronLikeIpcRenderer,
  channels = EFFECT_ELECTRON_IPC_CHANNELS,
): EffectElectronIpcRendererBridge {
  return {
    send: (frame) => {
      if (!isEffectElectronIpcRendererFrame(frame)) {
        throw new TypeError("Invalid Effect RPC renderer frame");
      }
      electronIpcRenderer.send(channels.rendererToMain, frame);
    },
    subscribe: (listener) => {
      const wrapped = (_event: unknown, frame: unknown) => {
        if (isEffectElectronIpcMainFrame(frame)) {
          listener(frame);
        }
      };

      electronIpcRenderer.on(channels.mainToRenderer, wrapped);
      return () => {
        removeIpcListener(electronIpcRenderer, channels.mainToRenderer, wrapped);
      };
    },
  };
}

export function exposeEffectElectronIpcPreloadBridge(options: {
  readonly contextBridge: ElectronLikeContextBridge;
  readonly ipcRenderer: ElectronLikeIpcRenderer;
  readonly globalKey?: string;
  readonly channels?: typeof EFFECT_ELECTRON_IPC_CHANNELS;
}): void {
  options.contextBridge.exposeInMainWorld(
    options.globalKey ?? EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY,
    makeEffectElectronIpcPreloadBridge(options.ipcRenderer, options.channels),
  );
}

function removeIpcListener<TListener>(
  target: {
    readonly off?: (channel: string, listener: TListener) => unknown;
    readonly removeListener?: (channel: string, listener: TListener) => unknown;
  },
  channel: string,
  listener: TListener,
): void {
  if (target.off) {
    target.off(channel, listener);
    return;
  }
  target.removeListener?.(channel, listener);
}

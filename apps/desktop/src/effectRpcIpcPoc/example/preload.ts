import { contextBridge, ipcRenderer } from "electron";

import { exposeEffectElectronIpcPreloadBridge } from "effect-electron-ipc/preload";

exposeEffectElectronIpcPreloadBridge({
  contextBridge,
  ipcRenderer,
});

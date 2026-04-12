import React from "react";

import { type RemoteAppModel, useRemoteAppState } from "./use-remote-app-state";

const RemoteAppStateContext = React.createContext<RemoteAppModel | null>(null);

export function RemoteAppStateProvider(props: React.PropsWithChildren) {
  const app = useRemoteAppState();

  return (
    <RemoteAppStateContext.Provider value={app}>{props.children}</RemoteAppStateContext.Provider>
  );
}

export function useRemoteApp() {
  const app = React.use(RemoteAppStateContext);
  if (app === null) {
    throw new Error("useRemoteApp must be used within RemoteAppStateProvider.");
  }
  return app;
}

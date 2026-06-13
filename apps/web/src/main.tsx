import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { DesktopClerkProvider } from "./cloud/desktopClerk";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <RouterProvider router={router} />;

if (import.meta.env.VITE_REACT_SCAN_DEMO === "1") {
  const draftId = DraftId.make("react-scan-demo");
  useComposerDraftStore.getState().setProjectDraftThreadId(
    scopeProjectRef("react-scan-env" as EnvironmentId, "react-scan-project" as ProjectId),
    draftId,
    {
      threadId: "react-scan-thread" as ThreadId,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && hasCloudPublicConfig() ? (
      isElectron ? (
        <DesktopClerkProvider publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </DesktopClerkProvider>
      ) : (
        <ClerkProvider publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);

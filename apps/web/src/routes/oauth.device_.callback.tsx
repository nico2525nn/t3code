import { createFileRoute } from "@tanstack/react-router";

import { DeviceAuthorizationCallbackSurface } from "../components/auth/DeviceAuthorizationSurface";

export const Route = createFileRoute("/oauth/device_/callback")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: DeviceAuthorizationCallbackRouteView,
});

function DeviceAuthorizationCallbackRouteView() {
  const { code, state, error } = Route.useSearch();
  return (
    <DeviceAuthorizationCallbackSurface
      {...(code ? { code } : {})}
      {...(state ? { state } : {})}
      {...(error ? { authorizationError: error } : {})}
    />
  );
}

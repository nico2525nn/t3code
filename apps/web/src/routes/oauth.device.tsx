import { createFileRoute } from "@tanstack/react-router";

import { DeviceAuthorizationSurface } from "../components/auth/DeviceAuthorizationSurface";

export const Route = createFileRoute("/oauth/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code: typeof search.user_code === "string" ? search.user_code : undefined,
  }),
  component: DeviceAuthorizationRouteView,
});

function DeviceAuthorizationRouteView() {
  const { user_code } = Route.useSearch();
  return <DeviceAuthorizationSurface {...(user_code ? { initialUserCode: user_code } : {})} />;
}

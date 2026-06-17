import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    assetEnvironment.createUrl({
      environmentId,
      input: { resource },
    }),
  );
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return null;
  }
  return resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
}

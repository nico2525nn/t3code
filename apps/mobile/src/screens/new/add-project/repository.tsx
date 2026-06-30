import { NativeStackScreenOptions, useRouteParams } from "../../../navigation/native-stack-header";
import { addProjectRemoteSourceLabel } from "@t3tools/client-runtime/operations/projects";

import { AddProjectRepositoryScreen } from "../../../features/projects/AddProjectScreen";

export default function AddProjectRepositoryRoute() {
  const params = useRouteParams<{ source?: string | string[] }>();
  const source = Array.isArray(params.source) ? params.source[0] : params.source;
  const title =
    source === "github" ||
    source === "gitlab" ||
    source === "bitbucket" ||
    source === "azure-devops"
      ? addProjectRemoteSourceLabel(source)
      : "Git URL";

  return (
    <>
      <NativeStackScreenOptions options={{ title }} />
      <AddProjectRepositoryScreen />
    </>
  );
}

import { NativeStackScreenOptions, useRouteParams } from "../../navigation/native-stack-header";

import { NewTaskDraftScreen } from "../../features/threads/NewTaskDraftScreen";

export default function NewTaskDraftRoute() {
  const params = useRouteParams<{
    environmentId?: string | string[];
    projectId?: string | string[];
    title?: string | string[];
  }>();

  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: Array.isArray(params.title) ? params.title[0] : (params.title ?? "New task"),
        }}
      />
      <NewTaskDraftScreen
        initialProjectRef={{
          environmentId: Array.isArray(params.environmentId)
            ? params.environmentId[0]
            : params.environmentId,
          projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
        }}
      />
    </>
  );
}

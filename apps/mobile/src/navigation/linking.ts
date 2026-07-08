import type { LinkingOptions } from "@react-navigation/native";
import * as Linking from "expo-linking";

import type { AppStackParamList } from "./route-model";

export const appLinking: LinkingOptions<AppStackParamList> = {
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  config: {
    screens: {
      Home: "",
      DebugRnsGlass: "debug/rns-glass",
      Settings: {
        path: "settings",
        screens: {
          SettingsIndex: "",
          SettingsEnvironments: "environments",
          SettingsEnvironmentNew: "environment-new",
          SettingsArchive: "archive",
          SettingsAuth: "auth",
          SettingsWaitlist: "waitlist",
        },
      },
      Connections: "connections",
      ConnectionsNew: "connections/new",
      NewTask: "new",
      AddProject: "new/add-project",
      AddProjectRepository: "new/add-project/repository",
      AddProjectDestination: "new/add-project/destination",
      AddProjectLocal: "new/add-project/local",
      NewTaskDraft: "new/draft",
      Thread: "threads/:environmentId/:threadId",
      ThreadTerminal: "threads/:environmentId/:threadId/terminal",
      ThreadReview: "threads/:environmentId/:threadId/review",
      ThreadReviewComment: "threads/:environmentId/:threadId/review-comment",
      ThreadFiles: "threads/:environmentId/:threadId/files",
      ThreadFile: "threads/:environmentId/:threadId/files/:path*",
      GitOverview: "threads/:environmentId/:threadId/git",
      GitCommit: "threads/:environmentId/:threadId/git/commit",
      GitBranches: "threads/:environmentId/:threadId/git/branches",
      GitConfirm: "threads/:environmentId/:threadId/git-confirm",
      NotFound: "*",
    },
  },
};

import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, type ReactNode } from "react";
import { StatusBar, useColorScheme, useWindowDimensions } from "react-native";
import { useResolveClassNames } from "uniwind";

import { ArchivedThreadsRouteScreen } from "../features/archive/ArchivedThreadsRouteScreen";
import { useAgentNotificationNavigation } from "../features/agent-awareness/notificationNavigation";
import {
  ClerkSettingsSheetDetentProvider,
  useClerkSettingsSheetDetent,
} from "../features/cloud/ClerkSettingsSheetDetent";
import {
  AdaptiveWorkspaceLayout,
  useAdaptiveWorkspaceLayout,
} from "../features/layout/AdaptiveWorkspaceLayout";
import { ThreadFilesTreeScreen, ThreadFileScreen } from "../features/files/ThreadFilesRouteScreen";
import { HardwareKeyboardCommandProvider } from "../features/keyboard/HardwareKeyboardCommandProvider";
import { ReviewCommentComposerSheet } from "../features/review/ReviewCommentComposerSheet";
import { ReviewHighlighterProvider } from "../features/review/ReviewHighlighterProvider";
import { ReviewSheet } from "../features/review/ReviewSheet";
import { ThreadTerminalRouteScreen } from "../features/terminal/ThreadTerminalRouteScreen";
import { ThreadRouteScreen } from "../features/threads/ThreadRouteScreen";
import { GitBranchesSheet } from "../features/threads/git/GitBranchesSheet";
import { GitCommitSheet } from "../features/threads/git/GitCommitSheet";
import { GitConfirmSheet } from "../features/threads/git/GitConfirmSheet";
import { GitOverviewSheet } from "../features/threads/git/GitOverviewSheet";
import { deriveStableFormSheetDetent } from "../lib/layout";
import { useThemeColor } from "../lib/useThemeColor";
import NotFoundRoute from "../screens/+not-found";
import ConnectionsRouteScreen from "../screens/connections";
import ConnectionsNewRouteScreen from "../screens/connections/new";
import RnsGlassDebugRoute from "../screens/debug/rns-glass";
import HomeRouteScreen from "../screens";
import AddProjectRoute from "../screens/new/add-project";
import AddProjectDestinationRoute from "../screens/new/add-project/destination";
import AddProjectLocalRoute from "../screens/new/add-project/local";
import AddProjectRepositoryRoute from "../screens/new/add-project/repository";
import NewTaskDraftRoute from "../screens/new/draft";
import NewTaskRoute from "../screens/new";
import SettingsAuthRouteScreen from "../screens/settings/auth";
import SettingsEnvironmentsRouteScreen from "../screens/settings/environments";
import SettingsRouteScreen from "../screens/settings";
import SettingsWaitlistRouteScreen from "../screens/settings/waitlist";
import { ThreadSelectionProvider } from "../state/use-thread-selection";
import { useThreadOutboxDrain } from "../state/use-thread-outbox-drain";
import { useCurrentPathname } from "./app-navigation";
import type { AppStackParamList, SettingsStackParamList } from "./route-model";

const RootStack = createNativeStackNavigator<AppStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

function ThreadSelectionRoute(props: { readonly children: ReactNode }) {
  return <ThreadSelectionProvider>{props.children}</ThreadSelectionProvider>;
}

function ThreadRoute() {
  return (
    <ThreadSelectionRoute>
      <ThreadRouteScreen />
    </ThreadSelectionRoute>
  );
}

function ThreadTerminalRoute() {
  return (
    <ThreadSelectionRoute>
      <ThreadTerminalRouteScreen />
    </ThreadSelectionRoute>
  );
}

function ThreadFilesRoute() {
  return (
    <ThreadSelectionRoute>
      <ThreadFilesTreeScreen />
    </ThreadSelectionRoute>
  );
}

function ThreadFileRoute() {
  return (
    <ThreadSelectionRoute>
      <ThreadFileScreen />
    </ThreadSelectionRoute>
  );
}

function ThreadReviewRoute() {
  return (
    <ThreadSelectionRoute>
      <ReviewHighlighterProvider>
        <ReviewSheet />
      </ReviewHighlighterProvider>
    </ThreadSelectionRoute>
  );
}

function ThreadReviewCommentRoute() {
  return (
    <ThreadSelectionRoute>
      <ReviewCommentComposerSheet />
    </ThreadSelectionRoute>
  );
}

function GitOverviewRoute() {
  return (
    <ThreadSelectionRoute>
      <GitOverviewSheet />
    </ThreadSelectionRoute>
  );
}

function GitCommitRoute() {
  return (
    <ThreadSelectionRoute>
      <GitCommitSheet />
    </ThreadSelectionRoute>
  );
}

function GitBranchesRoute() {
  return (
    <ThreadSelectionRoute>
      <GitBranchesSheet />
    </ThreadSelectionRoute>
  );
}

function GitConfirmRoute() {
  return (
    <ThreadSelectionRoute>
      <GitConfirmSheet />
    </ThreadSelectionRoute>
  );
}

export function RootNavigator() {
  const pathname = useCurrentPathname();
  const expandedSettingsRouteIsActive =
    pathname === "/settings/archive" || pathname === "/settings/auth";

  return (
    <HardwareKeyboardCommandProvider>
      <ClerkSettingsSheetDetentProvider initiallyExpanded={expandedSettingsRouteIsActive}>
        <RootNavigatorContent />
      </ClerkSettingsSheetDetentProvider>
    </HardwareKeyboardCommandProvider>
  );
}

function RootNavigatorContent() {
  const pathname = useCurrentPathname();
  const isDebugRoute = pathname.startsWith("/debug/");

  if (isDebugRoute) {
    return <DebugNavigatorHost />;
  }

  return <WorkspaceNavigatorHost />;
}

function DebugNavigatorHost() {
  return (
    <>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="DebugRnsGlass" component={RnsGlassDebugRoute} />
        <RootStack.Screen name="Home" component={HomeRouteScreen} />
        <RootStack.Screen name="NotFound" component={NotFoundRoute} />
      </RootStack.Navigator>
    </>
  );
}

function WorkspaceNavigatorHost() {
  const colorScheme = useColorScheme();
  const statusBarBg = useThemeColor("--color-status-bar");
  useAgentNotificationNavigation();
  useThreadOutboxDrain();

  return (
    <>
      <StatusBar
        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={String(statusBarBg)}
        translucent
      />
      <AdaptiveWorkspaceLayout>
        <WorkspaceNavigator />
      </AdaptiveWorkspaceLayout>
    </>
  );
}

function WorkspaceNavigator() {
  const { collapse, isExpanded } = useClerkSettingsSheetDetent();
  const { layout } = useAdaptiveWorkspaceLayout();
  const { height } = useWindowDimensions();
  const sheetStyle = useResolveClassNames("bg-sheet");

  const handleSettingsTransitionEnd = useCallback(
    (event: { data: { closing: boolean } }) => {
      if (event.data.closing) {
        collapse();
      }
    },
    [collapse],
  );

  const connectionSheetScreenOptions = {
    contentStyle: sheetStyle,
    gestureEnabled: true,
    headerShown: true,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [0.55, 0.7],
    sheetGrabberVisible: true,
  };
  const settingsScreenOptions = layout.usesSplitView
    ? {
        animation: "none" as const,
        contentStyle: sheetStyle,
        gestureEnabled: false,
        headerShown: false,
        presentation: "card" as const,
      }
    : {
        ...connectionSheetScreenOptions,
        headerShown: false,
        sheetAllowedDetents: isExpanded ? [0.92] : [0.7],
      };
  const newTaskScreenOptions = {
    contentStyle: sheetStyle,
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [layout.usesSplitView ? deriveStableFormSheetDetent(height) : 0.92],
    sheetGrabberVisible: !layout.usesSplitView,
  };

  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      <RootStack.Screen
        name="Home"
        component={HomeRouteScreen}
        options={{
          contentStyle: { backgroundColor: "transparent" },
          headerShown: true,
          headerTransparent: true,
          headerShadowVisible: false,
        }}
      />
      <RootStack.Screen
        name="Settings"
        component={SettingsNavigator}
        listeners={{ transitionEnd: handleSettingsTransitionEnd }}
        options={settingsScreenOptions}
      />
      <RootStack.Screen
        name="Connections"
        component={ConnectionsRouteScreen}
        options={connectionSheetScreenOptions}
      />
      <RootStack.Screen
        name="ConnectionsNew"
        component={ConnectionsNewRouteScreen}
        options={connectionSheetScreenOptions}
      />
      <RootStack.Screen name="NewTask" component={NewTaskRoute} options={newTaskScreenOptions} />
      <RootStack.Screen
        name="AddProject"
        component={AddProjectRoute}
        options={newTaskScreenOptions}
      />
      <RootStack.Screen
        name="AddProjectRepository"
        component={AddProjectRepositoryRoute}
        options={newTaskScreenOptions}
      />
      <RootStack.Screen
        name="AddProjectDestination"
        component={AddProjectDestinationRoute}
        options={newTaskScreenOptions}
      />
      <RootStack.Screen
        name="AddProjectLocal"
        component={AddProjectLocalRoute}
        options={newTaskScreenOptions}
      />
      <RootStack.Screen
        name="NewTaskDraft"
        component={NewTaskDraftRoute}
        options={newTaskScreenOptions}
      />
      <RootStack.Screen
        name="Thread"
        component={ThreadRoute}
        options={{
          animation: layout.usesSplitView ? "none" : "slide_from_right",
          contentStyle: { backgroundColor: "transparent" },
          gestureEnabled: !layout.usesSplitView,
          headerShown: false,
        }}
      />
      <RootStack.Screen
        name="ThreadTerminal"
        component={ThreadTerminalRoute}
        options={{ contentStyle: sheetStyle, headerShown: false }}
      />
      <RootStack.Screen
        name="ThreadReview"
        component={ThreadReviewRoute}
        options={{ contentStyle: sheetStyle, headerShown: false }}
      />
      <RootStack.Screen
        name="ThreadReviewComment"
        component={ThreadReviewCommentRoute}
        options={{
          contentStyle: sheetStyle,
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: [0.72, 0.92],
          sheetGrabberVisible: true,
        }}
      />
      <RootStack.Screen
        name="ThreadFiles"
        component={ThreadFilesRoute}
        options={{ contentStyle: sheetStyle, headerShown: false }}
      />
      <RootStack.Screen
        name="ThreadFile"
        component={ThreadFileRoute}
        options={{ contentStyle: sheetStyle, headerShown: false }}
      />
      <RootStack.Screen
        name="GitOverview"
        component={GitOverviewRoute}
        options={{
          contentStyle: sheetStyle,
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: [0.85],
          sheetGrabberVisible: true,
        }}
      />
      <RootStack.Screen
        name="GitCommit"
        component={GitCommitRoute}
        options={{ contentStyle: sheetStyle, headerShown: false }}
      />
      <RootStack.Screen
        name="GitBranches"
        component={GitBranchesRoute}
        options={{ contentStyle: sheetStyle, headerShown: false }}
      />
      <RootStack.Screen
        name="GitConfirm"
        component={GitConfirmRoute}
        options={{
          contentStyle: sheetStyle,
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: [0.4],
          sheetGrabberVisible: true,
        }}
      />
      <RootStack.Screen
        name="DebugRnsGlass"
        component={RnsGlassDebugRoute}
        options={{
          animation: "none",
          contentStyle: { backgroundColor: "transparent" },
          headerShown: false,
        }}
      />
      <RootStack.Screen name="NotFound" component={NotFoundRoute} />
    </RootStack.Navigator>
  );
}

function SettingsNavigator() {
  const sheetStyle = useResolveClassNames("bg-sheet");

  return (
    <SettingsStack.Navigator
      initialRouteName="SettingsIndex"
      screenOptions={{
        contentStyle: sheetStyle,
        headerShown: true,
      }}
    >
      <SettingsStack.Screen name="SettingsIndex" component={SettingsRouteScreen} />
      <SettingsStack.Screen
        name="SettingsEnvironments"
        component={SettingsEnvironmentsRouteScreen}
      />
      <SettingsStack.Screen name="SettingsEnvironmentNew" component={ConnectionsNewRouteScreen} />
      <SettingsStack.Screen name="SettingsArchive" component={ArchivedThreadsRouteScreen} />
      <SettingsStack.Screen name="SettingsAuth" component={SettingsAuthRouteScreen} />
      <SettingsStack.Screen name="SettingsWaitlist" component={SettingsWaitlistRouteScreen} />
    </SettingsStack.Navigator>
  );
}

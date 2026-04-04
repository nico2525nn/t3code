export { TerminalProcessInspectionError, WebPortInspectionError } from "./Errors";
export {
  TerminalProcessInspectorLive,
  subprocessCheckerToInspector,
} from "./Layers/TerminalProcessInspector";
export { WebPortInspectorLive } from "./Layers/WebPortInspector";
export { TerminalProcessInspector } from "./Services/TerminalProcessInspector";
export { WebPortInspector } from "./Services/WebPortInspector";

export { arePortListsEqual, normalizeRunningPorts } from "./utils";

export type {
  TerminalSubprocessActivity,
  TerminalSubprocessChecker,
  TerminalSubprocessInspector,
  TerminalWebPortInspector,
} from "./types";

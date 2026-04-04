import { collectPosixProcessFamilyPids, checkPosixListeningPorts } from "./posix";
import { type TerminalSubprocessActivity } from "./types";
import { checkWindowsListeningPorts, collectWindowsProcessFamilyPids } from "./win32";

export { arePortListsEqual, normalizeRunningPorts } from "./utils";

export type {
  TerminalSubprocessActivity,
  TerminalSubprocessChecker,
  TerminalSubprocessInspector,
  TerminalWebPortInspector,
} from "./types";

export async function defaultSubprocessInspector(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return { hasRunningSubprocess: false, runningPorts: [] };
  }

  if (process.platform === "win32") {
    const processFamilyPids = await collectWindowsProcessFamilyPids(terminalPid);
    if (processFamilyPids.length === 0) {
      return { hasRunningSubprocess: false, runningPorts: [] };
    }

    const subprocessPids = processFamilyPids.filter((pid) => pid !== terminalPid);
    const runningPorts = await checkWindowsListeningPorts(processFamilyPids);
    return {
      hasRunningSubprocess: subprocessPids.length > 0 || runningPorts.length > 0,
      runningPorts,
    };
  }

  const processFamilyPids = await collectPosixProcessFamilyPids(terminalPid);
  if (processFamilyPids.length === 0) {
    return { hasRunningSubprocess: false, runningPorts: [] };
  }

  const subprocessPids = processFamilyPids.filter((pid) => pid !== terminalPid);
  const runningPorts = await checkPosixListeningPorts(processFamilyPids);
  return {
    hasRunningSubprocess: subprocessPids.length > 0 || runningPorts.length > 0,
    runningPorts,
  };
}

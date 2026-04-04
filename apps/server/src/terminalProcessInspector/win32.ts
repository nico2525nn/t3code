import { runProcess } from "../processRunner";
import { parsePortList } from "./utils";

export async function collectWindowsProcessFamilyPids(terminalPid: number): Promise<number[]> {
  const command = [
    "$procs = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId -ErrorAction SilentlyContinue",
    "if (-not $procs) { exit 0 }",
    '$procs | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 2_000,
        allowNonZeroExit: true,
        maxBufferBytes: 262_144,
        outputMode: "truncate",
      },
    );
    if (result.code !== 0) {
      return [];
    }

    const childrenByParentPid = new Map<number, number[]>();
    for (const line of result.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const children = childrenByParentPid.get(ppid);
      if (children) {
        children.push(pid);
      } else {
        childrenByParentPid.set(ppid, [pid]);
      }
    }

    const processFamily = new Set<number>([terminalPid]);
    const pendingParents = [terminalPid];
    while (pendingParents.length > 0) {
      const parentPid = pendingParents.shift();
      if (!parentPid) continue;
      const childPids = childrenByParentPid.get(parentPid);
      if (!childPids || childPids.length === 0) continue;
      for (const childPid of childPids) {
        if (processFamily.has(childPid)) continue;
        processFamily.add(childPid);
        pendingParents.push(childPid);
      }
    }

    return [...processFamily];
  } catch {
    return [];
  }
}

export async function checkWindowsListeningPorts(processIds: number[]): Promise<number[]> {
  if (processIds.length === 0) return [];

  const processFilter = processIds.map((pid) => `$_.OwningProcess -eq ${pid}`).join(" -or ");
  const command = [
    "$connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue",
    `$matching = $connections | Where-Object { ${processFilter} }`,
    "if (-not $matching) { exit 0 }",
    "$matching | Select-Object -ExpandProperty LocalPort -Unique",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 65_536,
        outputMode: "truncate",
      },
    );
    if (result.code !== 0) {
      return [];
    }
    return parsePortList(result.stdout);
  } catch {
    return [];
  }
}

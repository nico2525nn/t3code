import { MAX_PORT_NUMBER, normalizeRunningPorts } from "@t3tools/shared/port";

export { MAX_PORT_NUMBER, normalizeRunningPorts };

export function parsePidList(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    pids.push(pid);
  }
  return [...new Set(pids)];
}

export function parsePortList(stdout: string): number[] {
  const ports: number[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const port = Number(line.trim());
    if (!Number.isInteger(port)) {
      continue;
    }
    ports.push(port);
  }
  return normalizeRunningPorts(ports);
}

export function portFromAddress(address: string): number | null {
  const match = address.match(/:(\d+)$/);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT_NUMBER) {
    return null;
  }
  return port;
}

export function arePortListsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

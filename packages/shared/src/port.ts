export const MAX_PORT_NUMBER = 65_535;

export function normalizeRunningPorts(ports: readonly number[] | undefined): number[] {
  if (!ports || ports.length === 0) return [];
  return [...new Set(ports)]
    .filter((port) => Number.isInteger(port) && port > 0 && port <= MAX_PORT_NUMBER)
    .toSorted((left, right) => left - right);
}

export interface PortStatusLabel {
  label: string;
  primaryWebPort: number | null;
}

export function portStatusLabel(runningPorts: readonly number[]): PortStatusLabel {
  const primaryWebPort = runningPorts[0] ?? null;
  const label =
    runningPorts.length === 0
      ? "Terminal process running"
      : runningPorts.length === 1
        ? `Open web server: http://localhost:${primaryWebPort}`
        : `Open web server: http://localhost:${primaryWebPort} (detected web ports: ${runningPorts.join(", ")})`;
  return { label, primaryWebPort };
}

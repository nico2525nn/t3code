import { type ChildProcess } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:net";

const PERF_SEED_JSON_START = "__T3_PERF_SEED_JSON_START__";
const PERF_SEED_JSON_END = "__T3_PERF_SEED_JSON_END__";

export async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve a free localhost port."));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

export async function waitForServerReady(url: string, process: ChildProcess): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 45_000;
  const requestTimeoutMs = 1_000;

  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Perf server exited early with code ${process.exitCode}.`);
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore connection races while the server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  throw new Error(`Timed out waiting for perf server readiness at ${url}.`);
}

export async function stopChildProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) {
    return;
  }

  process.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolveExited) => {
    const timer = setTimeout(() => resolveExited(false), 5_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolveExited(true);
    });
  });

  if (!exited && process.exitCode === null) {
    process.kill("SIGKILL");
    await new Promise<void>((resolveExited) => {
      process.once("exit", () => resolveExited());
    });
  }
}

export async function cleanupPerfRunDir(runParentDir: string): Promise<void> {
  await rm(runParentDir, { recursive: true, force: true });
}

export async function verifyBuiltArtifacts(paths: ReadonlyArray<string>): Promise<void> {
  await Promise.all(paths.map((p) => access(p))).catch(() => {
    throw new Error(
      `Built perf artifacts are missing. Expected ${paths.join(" and ")}. Run bun run test:perf:web or build the app first.`,
    );
  });
}

export function parsePerfSeededState<T>(stdout: string): T {
  const startIndex = stdout.lastIndexOf(PERF_SEED_JSON_START);
  const endIndex = stdout.lastIndexOf(PERF_SEED_JSON_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const payload = stdout.slice(startIndex + PERF_SEED_JSON_START.length, endIndex).trim();
    return JSON.parse(payload) as T;
  }

  return JSON.parse(stdout) as T;
}

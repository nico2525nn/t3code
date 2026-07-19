// @effect-diagnostics nodeBuiltinImport:off - electron-builder hooks run outside an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const REQUIRED_UNPACKED_RUNTIME_FILES = [
  "effect/package.json",
  "effect/dist/Context.js",
  "@effect/platform-node/package.json",
  "@effect/platform-node/dist/NodeHttpClient.js",
  "@effect/platform-node-shared/package.json",
  "mime/package.json",
  "undici/package.json",
] as const;

interface DesktopAfterPackContext {
  readonly appOutDir: string;
}

export async function verifyUnpackedRuntimeFiles(appOutDir: string): Promise<void> {
  const unpackedNodeModules = NodePath.join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
  );
  const missingFiles: string[] = [];

  for (const relativeFile of REQUIRED_UNPACKED_RUNTIME_FILES) {
    try {
      await NodeFSP.access(NodePath.join(unpackedNodeModules, ...relativeFile.split("/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      missingFiles.push(relativeFile);
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(
      `Packaged runtime verification failed: app.asar references unpacked runtime files whose payloads are missing: ${missingFiles.join(", ")}`,
    );
  }
}

export async function afterPack(context: DesktopAfterPackContext): Promise<void> {
  await verifyUnpackedRuntimeFiles(context.appOutDir);
}

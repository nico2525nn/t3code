// @effect-diagnostics nodeBuiltinImport:off - This fixture verifies the packaging filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  REQUIRED_UNPACKED_RUNTIME_FILES,
  verifyUnpackedRuntimeFiles,
} from "./desktop-after-pack.ts";

const temporaryDirectories: string[] = [];

async function createPackagedRuntimeFixture(): Promise<{
  readonly root: string;
  readonly appOutDir: string;
  readonly unpackedNodeModules: string;
}> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-after-pack-"));
  temporaryDirectories.push(root);
  const appOutDir = NodePath.join(root, "win-unpacked");
  const unpackedNodeModules = NodePath.join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
  );

  for (const relativeFile of REQUIRED_UNPACKED_RUNTIME_FILES) {
    const filePath = NodePath.join(unpackedNodeModules, ...relativeFile.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
    await NodeFSP.writeFile(filePath, `${relativeFile}\n`);
  }

  return { root, appOutDir, unpackedNodeModules };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop afterPack", () => {
  it("accepts a complete unpacked runtime closure", async () => {
    const fixture = await createPackagedRuntimeFixture();

    await verifyUnpackedRuntimeFiles(fixture.appOutDir);
  });

  it("fails the build when unpacked runtime payloads are missing", async () => {
    const fixture = await createPackagedRuntimeFixture();
    await NodeFSP.rm(NodePath.join(fixture.unpackedNodeModules, "effect/dist/Context.js"));
    await NodeFSP.rm(NodePath.join(fixture.unpackedNodeModules, "mime/package.json"));

    await expect(verifyUnpackedRuntimeFiles(fixture.appOutDir)).rejects.toThrow(
      /effect\/dist\/Context\.js, mime\/package\.json/u,
    );
  });
});

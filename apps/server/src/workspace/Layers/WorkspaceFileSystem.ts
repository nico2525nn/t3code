import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

function makeReadFileError(input: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly detail: string;
  readonly cause?: unknown;
}) {
  return new WorkspaceFileSystemError({
    cwd: input.cwd,
    relativePath: input.relativePath,
    operation: "workspaceFileSystem.readFile",
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function causeMessage(cause: { readonly message: string }) {
  return cause.message;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const [realWorkspaceRoot, realTargetPath] = yield* Effect.all([
        fileSystem.realPath(input.cwd),
        fileSystem.realPath(target.absolutePath),
      ]).pipe(
        Effect.mapError((cause) =>
          makeReadFileError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            detail: causeMessage(cause),
            cause,
          }),
        ),
      );

      const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
      if (
        relativeRealPath.startsWith(`..${path.sep}`) ||
        relativeRealPath === ".." ||
        path.isAbsolute(relativeRealPath)
      ) {
        return yield* makeReadFileError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          detail: "Workspace file path resolves outside the project root.",
        });
      }

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(realTargetPath, { flag: "r" }).pipe(
            Effect.mapError((cause) =>
              makeReadFileError({
                cwd: input.cwd,
                relativePath: input.relativePath,
                detail: causeMessage(cause),
                cause,
              }),
            ),
          );
          const stat = yield* handle.stat.pipe(
            Effect.mapError((cause) =>
              makeReadFileError({
                cwd: input.cwd,
                relativePath: input.relativePath,
                detail: causeMessage(cause),
                cause,
              }),
            ),
          );
          if (stat.type !== "File") {
            return yield* makeReadFileError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              detail: "Workspace path is not a file.",
            });
          }
          const truncated = stat.size > FileSystem.Size(PROJECT_READ_FILE_MAX_BYTES);
          const bytesToRead = truncated ? PROJECT_READ_FILE_MAX_BYTES : Number(stat.size);
          const buffer = new Uint8Array(bytesToRead);
          const bytesRead = yield* handle.read(buffer).pipe(
            Effect.mapError((cause) =>
              makeReadFileError({
                cwd: input.cwd,
                relativePath: input.relativePath,
                detail: causeMessage(cause),
                cause,
              }),
            ),
          );
          const fileBytes = buffer.subarray(0, Number(bytesRead));
          if (fileBytes.includes(0)) {
            return yield* makeReadFileError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              detail: "Binary files cannot be previewed as text.",
            });
          }
          const contents = new TextDecoder("utf-8").decode(fileBytes);
          return {
            relativePath: target.relativePath,
            contents,
            byteLength: Number(stat.size),
            truncated,
          };
        }),
      );

      return result;
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);

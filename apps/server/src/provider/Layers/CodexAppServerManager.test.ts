// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  codexAppServerControlSocketPath,
  makeCodexAppServerManager,
} from "./CodexAppServerManager.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const fixtureDirectory = NodePath.join(import.meta.dirname, "../testFixtures");
const fixturePath = NodePath.join(fixtureDirectory, "app-server");

it("uses Codex's canonical daemon control socket layout", () => {
  const codexHome = NodePath.join(NodeOS.tmpdir(), "t3-codex-home");

  assert.equal(
    codexAppServerControlSocketPath(codexHome),
    NodePath.join(codexHome, "app-server-control", "app-server-control.sock"),
  );
});

it.layer(NodeServices.layer)("CodexAppServerManager", (it) => {
  it.effect("follows catalog pages and reads complete native history", () =>
    Effect.gen(function* () {
      const manager = yield* makeCodexAppServerManager({
        instanceId: ProviderInstanceId.make("codex-manager-catalog-test"),
        binaryPath: process.execPath,
        cwd: fixtureDirectory,
      });
      yield* Effect.addFinalizer(() => manager.close);

      const threads = yield* manager.listThreads({ archived: false, limit: 1 });
      expect(threads.map((thread) => thread.id)).toEqual(["catalog-thread-1", "catalog-thread-2"]);

      const thread = yield* manager.readThread("catalog-thread-1");
      expect(thread.turns[0]?.items).toMatchObject([
        {
          id: "catalog-thread-1-user",
          type: "userMessage",
        },
        {
          id: "catalog-thread-1-assistant",
          type: "agentMessage",
          text: "assistant message for catalog-thread-1",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shares one daemon and routes native thread notifications to bindings", () =>
    Effect.gen(function* () {
      const markerPath = NodePath.join(
        NodeOS.tmpdir(),
        `t3-codex-manager-test-${process.pid}-${DateTime.toEpochMillis(DateTime.nowUnsafe())}.log`,
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(markerPath, { force: true })),
      );

      const manager = yield* makeCodexAppServerManager({
        instanceId: ProviderInstanceId.make("codex-manager-test"),
        binaryPath: process.execPath,
        cwd: fixtureDirectory,
        environment: {
          ...process.env,
          T3_CODEX_MANAGER_TEST_MARKER: markerPath,
          T3_CODEX_MANAGER_TEST_SERVER_REQUESTS: "1",
        },
      });
      yield* Effect.addFinalizer(() => manager.close);

      const first = yield* manager
        .openSession({
          threadId: ThreadId.make("t3-thread-first"),
        })
        .pipe(Effect.timeout("5 seconds"));
      const second = yield* manager
        .openSession({
          threadId: ThreadId.make("t3-thread-second"),
        })
        .pipe(Effect.timeout("5 seconds"));
      const firstDeltas = yield* Queue.unbounded<unknown>();
      const secondDeltas = yield* Queue.unbounded<unknown>();
      const firstStarted = yield* Queue.unbounded<unknown>();
      const secondStarted = yield* Queue.unbounded<unknown>();
      const firstGlobals = yield* Queue.unbounded<unknown>();
      const secondGlobals = yield* Queue.unbounded<unknown>();
      const firstServerResponses = yield* Queue.unbounded<unknown>();
      const secondServerResponses = yield* Queue.unbounded<unknown>();
      const unknownRequestResponses = yield* Queue.unbounded<unknown>();

      yield* first.client.handleUnknownServerRequest(() => Effect.succeed({ owner: "first" }));
      yield* second.client.handleUnknownServerRequest(() => Effect.succeed({ owner: "second" }));
      yield* first.client.handleUnknownServerNotification((method, payload) => {
        if (method === "test/global-notification") {
          return Queue.offer(firstGlobals, payload).pipe(Effect.asVoid);
        }
        if (method === "test/server-response-seen") {
          return Queue.offer(firstServerResponses, payload).pipe(Effect.asVoid);
        }
        if (method === "test/unknown-response-seen") {
          return Queue.offer(unknownRequestResponses, payload).pipe(Effect.asVoid);
        }
        return Effect.void;
      });
      yield* second.client.handleUnknownServerNotification((method, payload) => {
        if (method === "test/global-notification") {
          return Queue.offer(secondGlobals, payload).pipe(Effect.asVoid);
        }
        if (method === "test/server-response-seen") {
          return Queue.offer(secondServerResponses, payload).pipe(Effect.asVoid);
        }
        return Effect.void;
      });

      yield* first.client.handleServerNotification("thread/started", (payload) =>
        Queue.offer(firstStarted, payload).pipe(Effect.asVoid),
      );
      yield* first.client.handleServerNotification("item/agentMessage/delta", (payload) =>
        Queue.offer(firstDeltas, payload).pipe(Effect.asVoid),
      );
      yield* second.client.handleServerNotification("thread/started", (payload) =>
        Queue.offer(secondStarted, payload).pipe(Effect.asVoid),
      );
      yield* second.client.handleServerNotification("item/agentMessage/delta", (payload) =>
        Queue.offer(secondDeltas, payload).pipe(Effect.asVoid),
      );

      const startParams = {
        cwd: NodeOS.tmpdir(),
        approvalPolicy: "never" as const,
        sandbox: "danger-full-access" as const,
        approvalsReviewer: "user" as const,
      };
      const firstResponse = yield* first.client
        .request("thread/start", startParams)
        .pipe(Effect.timeout("5 seconds"));
      const secondResponse = yield* second.client
        .request("thread/start", startParams)
        .pipe(Effect.timeout("5 seconds"));
      const firstThreadId = firstResponse.thread.id;
      const secondThreadId = secondResponse.thread.id;
      const firstStartedPayload = yield* Queue.take(firstStarted).pipe(Effect.timeout("5 seconds"));
      const secondStartedPayload = yield* Queue.take(secondStarted).pipe(
        Effect.timeout("5 seconds"),
      );
      const firstDelta = yield* Queue.take(firstDeltas).pipe(Effect.timeout("5 seconds"));
      const secondDelta = yield* Queue.take(secondDeltas).pipe(Effect.timeout("5 seconds"));
      const firstRawDelta = yield* first.client.raw.notifications.pipe(
        Stream.filter((notification) => notification.method === "item/agentMessage/delta"),
        Stream.runHead,
        Effect.timeout("5 seconds"),
        Effect.map(Option.getOrThrow),
      );
      const secondRawDelta = yield* second.client.raw.notifications.pipe(
        Stream.filter((notification) => notification.method === "item/agentMessage/delta"),
        Stream.runHead,
        Effect.timeout("5 seconds"),
        Effect.map(Option.getOrThrow),
      );
      const firstRawRequest = yield* first.client.raw.requests.pipe(
        Stream.filter((request) => request.method === "test/session-request"),
        Stream.runHead,
        Effect.timeout("5 seconds"),
        Effect.map(Option.getOrThrow),
      );
      const secondRawRequest = yield* second.client.raw.requests.pipe(
        Stream.filter((request) => request.method === "test/session-request"),
        Stream.runHead,
        Effect.timeout("5 seconds"),
        Effect.map(Option.getOrThrow),
      );
      const firstGlobal = yield* Queue.take(firstGlobals).pipe(Effect.timeout("5 seconds"));
      const secondGlobal = yield* Queue.take(secondGlobals).pipe(Effect.timeout("5 seconds"));
      const firstServerResponse = yield* Queue.take(firstServerResponses).pipe(
        Effect.timeout("5 seconds"),
      );
      const secondServerResponse = yield* Queue.take(secondServerResponses).pipe(
        Effect.timeout("5 seconds"),
      );
      const firstStderr = yield* first.stderr.pipe(
        Stream.runHead,
        Effect.timeout("5 seconds"),
        Effect.map(Option.getOrThrow),
      );
      const secondStderr = yield* second.stderr.pipe(
        Stream.runHead,
        Effect.timeout("5 seconds"),
        Effect.map(Option.getOrThrow),
      );

      assert.notEqual(firstThreadId, secondThreadId);
      assert.equal((firstStartedPayload as { thread: { id: string } }).thread.id, firstThreadId);
      assert.equal((secondStartedPayload as { thread: { id: string } }).thread.id, secondThreadId);
      assert.equal((firstDelta as { threadId: string }).threadId, firstThreadId);
      assert.equal((secondDelta as { threadId: string }).threadId, secondThreadId);
      assert.equal((firstRawDelta.params as { threadId: string }).threadId, firstThreadId);
      assert.equal((secondRawDelta.params as { threadId: string }).threadId, secondThreadId);
      assert.equal((firstRawRequest.params as { threadId: string }).threadId, firstThreadId);
      assert.equal((secondRawRequest.params as { threadId: string }).threadId, secondThreadId);
      assert.equal((firstGlobal as { value: string }).value, `global for ${firstThreadId}`);
      assert.equal((secondGlobal as { value: string }).value, `global for ${firstThreadId}`);
      assert.equal(firstStderr, `mock stderr ${firstThreadId}\n`);
      assert.equal(secondStderr, `mock stderr ${firstThreadId}\n`);
      assert.deepEqual((firstServerResponse as { result: unknown }).result, { owner: "first" });
      assert.deepEqual((secondServerResponse as { result: unknown }).result, {
        owner: "second",
      });

      const runtimeScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
      const runtimeSession = yield* manager.openSession({
        threadId: ThreadId.make("t3-runtime-thread"),
      });
      yield* Effect.addFinalizer(() => runtimeSession.close);
      const runtimeStderr = yield* Queue.unbounded<string>();
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("t3-runtime-thread"),
        binaryPath: process.execPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        threadConfig: {
          "mcp_servers.t3-code.url": "http://127.0.0.1/mcp",
        },
        client: runtimeSession.client,
        initializeClient: false,
        interruptOnClose: true,
        stderr: runtimeSession.stderr,
      }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
      const runtimeEventFiber = yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          event.method === "process/stderr" && event.message
            ? Queue.offer(runtimeStderr, event.message).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      const runtimeStarted = yield* runtime.start().pipe(Effect.timeout("5 seconds"));
      assert.equal(
        (runtimeStarted.resumeCursor as { readonly threadId?: string } | undefined)?.threadId,
        "native-thread-3",
      );
      assert.equal(
        yield* Queue.take(runtimeStderr).pipe(Effect.timeout("5 seconds")),
        "mock stderr native-thread-3",
      );
      const runtimeTurn = yield* runtime.sendTurn({ input: "keep this turn active" });
      assert.equal(runtimeTurn.turnId, "native-thread-3-turn");
      yield* Fiber.interrupt(runtimeEventFiber);
      yield* runtime.close;

      const exitSession = yield* manager.openSession({
        threadId: ThreadId.make("t3-exit-thread"),
      });
      yield* Effect.addFinalizer(() => exitSession.close);
      const exitReady = yield* Queue.unbounded<unknown>();
      yield* exitSession.client.handleUnknownServerNotification((method, payload) => {
        if (method === "test/ready-to-exit") {
          return Queue.offer(exitReady, payload).pipe(Effect.asVoid);
        }
        return Effect.void;
      });
      yield* exitSession.client
        .request("thread/start", {
          ...startParams,
          cwd: "/tmp/t3-codex-manager-exit-after-start",
        })
        .pipe(Effect.timeout("5 seconds"));
      yield* Queue.take(exitReady).pipe(Effect.timeout("5 seconds"));
      yield* exitSession.client.raw.notify("test/exit-daemon", undefined);
      yield* exitSession.appServerExit.pipe(Effect.timeout("5 seconds"));
      assert.equal(yield* exitSession.isConnected, false);

      const reconnected = yield* manager
        .openSession({
          threadId: ThreadId.make("t3-reconnected-thread"),
        })
        .pipe(Effect.timeout("5 seconds"));
      yield* Effect.addFinalizer(() => reconnected.close);
      const reconnectedResponse = yield* reconnected.client
        .request("thread/start", startParams)
        .pipe(Effect.timeout("5 seconds"));
      assert.equal(reconnectedResponse.thread.id, "native-thread-1");
      const unknownResponse = yield* Queue.take(unknownRequestResponses).pipe(
        Effect.timeout("5 seconds"),
      );
      assert.equal((unknownResponse as { error?: { code?: number } }).error?.code, -32601);

      yield* manager.close;
      const starts = NodeFS.readFileSync(markerPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line === "started");
      assert.equal(starts.length, 2);
      const interrupts = NodeFS.readFileSync(markerPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line === "turn/interrupt");
      assert.equal(interrupts.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

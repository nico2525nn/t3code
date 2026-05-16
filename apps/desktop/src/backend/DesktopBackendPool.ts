// Pool registry for multiple backend processes. This file is the entry
// point for the concurrent-Windows+WSL-backend feature; see the design
// notes below before extending it.
//
// Current state (step 4):
//   - `DesktopBackendManager.ts` no longer exposes a Context.Service. It
//     is a per-instance factory (`makeBackendInstance(spec)`); the pool
//     calls it once for the Windows primary at startup.
//   - The primary spec wires `configResolve` to `DesktopBackendConfiguration`
//     and the `onReady`/`onShutdown` callbacks to the window service's
//     `handleBackendReady` / `handleBackendNotReady`. Readiness is no
//     longer in `DesktopState`; the window owns its own latch.
//   - The pool exposes `register(spec)` and `unregister(id)` so other
//     services can attach a backend on demand. Each registered instance
//     gets its own child scope so unregister can stop it cleanly without
//     tearing down the whole pool.
//   - Consumers (window/wsl IPC, lifecycle hooks, telemetry) read the
//     primary instance off `pool.primary`. There is no longer a separate
//     `DesktopBackendManager` service in the layer graph.
//
// Target state (concurrent Windows + WSL):
//   - The pool layer constructs N instances — at minimum the Windows
//     primary; the WSL instance is added when the user enables the WSL
//     backend (with the selected distro).
//   - Per-instance state (readiness, restart fiber, active run) lives on
//     each `DesktopBackendInstance`. Step 3 splits backend log routing
//     per instance.
//   - `getLocalEnvironmentBootstrap()` widens to
//     `getLocalEnvironmentBootstraps()` returning one bootstrap per pool
//     instance; the frontend env runtime registers each as a local
//     environment.
//   - The WSL "swap" IPC is replaced by `enableWslBackend()` +
//     `setWslBackendDistro()` controlling which (if any) WSL instance the
//     pool holds. No more swap-mode, no more rollback-on-restart.
//
// Migration sequence (each step is its own commit):
//   1. Reshape `DesktopBackendManager` into an instance factory and route
//      consumers through the pool. Pool still holds a single instance.
//   2. Drop `DesktopState.backendReady`. The window owns its own
//      readiness latch, driven by the primary instance's onReady /
//      onShutdown callbacks.
//   3. Per-instance log routing: replace the singleton
//      DesktopBackendOutputLog with a factory that vends one rotating
//      writer per instance id (primary keeps server-child.log; others go
//      to server-child-<sanitized-id>.log).
//   4. (this commit) Add register/unregister so WSL backend can be added
//      on demand. No caller registers a second instance yet.
//   5. Wire WSL distro startup through the pool; remove `setWslBackend`
//      mode-swap IPC in favor of `enableWslBackend` / `setWslDistro`.
//   6. Widen `getLocalEnvironmentBootstrap` → `*Bootstraps`; frontend
//      runtime registers each pool instance as a local environment.
//   7. Drop the swap dialog + the "mode" appSetting. Settings UI gets a
//      "WSL backend enabled + distro" pair instead.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export type BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const PRIMARY_INSTANCE_ID = DesktopBackendManager.PRIMARY_INSTANCE_ID;
export type DesktopBackendInstance = DesktopBackendManager.DesktopBackendInstance;
export type BackendInstanceSpec = DesktopBackendManager.BackendInstanceSpec;

// Caller tried to register an id that's already in the pool. The pool
// refuses overwrites so two independent orchestrators racing on the
// same id surface as a typed failure instead of one silently winning.
export class DesktopBackendPoolInstanceAlreadyRegisteredError extends Data.TaggedError(
  "DesktopBackendPoolInstanceAlreadyRegisteredError",
)<{
  readonly id: BackendInstanceId;
}> {
  override get message() {
    return `Backend instance "${this.id}" is already registered in the pool.`;
  }
}

// Primary instance is registered for the pool's lifetime. Unregister is
// a no-op for it today (no real callers), but if someone wires it up
// later it's a clear bug rather than something to "handle".
export class DesktopBackendPoolCannotUnregisterPrimaryError extends Data.TaggedError(
  "DesktopBackendPoolCannotUnregisterPrimaryError",
)<{}> {
  override get message() {
    return "Refusing to unregister the primary backend from the pool.";
  }
}

export interface DesktopBackendPoolShape {
  // Look up a registered instance. None when no backend with that id is
  // currently registered (e.g. WSL backend disabled).
  readonly get: (id: BackendInstanceId) => Effect.Effect<Option.Option<DesktopBackendInstance>>;
  // Snapshot of all currently-registered instances. Order is unspecified;
  // callers that need a canonical "primary first" view should sort by id.
  readonly list: Effect.Effect<readonly DesktopBackendInstance[]>;
  // Convenience accessor for the always-registered primary instance.
  // Currently equivalent to `get(PRIMARY_INSTANCE_ID)` unwrapped, but
  // exposed as a typed effect so consumers don't have to handle the
  // Option for the case that's guaranteed to be present.
  readonly primary: Effect.Effect<DesktopBackendInstance>;
  // Build a fresh DesktopBackendInstance from `spec` and add it to the
  // registry. The pool owns the instance's scope: unregister(id) or pool
  // teardown closes it and runs the instance's auto-stop finalizer. The
  // returned instance has not been started — callers decide when to
  // start it (and can call start more than once if a retry-after-failure
  // story makes sense for them).
  readonly register: (
    spec: BackendInstanceSpec,
  ) => Effect.Effect<DesktopBackendInstance, DesktopBackendPoolInstanceAlreadyRegisteredError>;
  // Stop the named instance and remove it from the registry. Closing the
  // instance's scope triggers its auto-stop finalizer; the registry is
  // updated atomically with the scope close so subsequent get(id) calls
  // observe the unregister before the underlying child process has fully
  // exited.
  readonly unregister: (
    id: BackendInstanceId,
  ) => Effect.Effect<void, DesktopBackendPoolCannotUnregisterPrimaryError>;
}

export class DesktopBackendPool extends Context.Service<
  DesktopBackendPool,
  DesktopBackendPoolShape
>()("t3/desktop/BackendPool") {}

// Services required by makeBackendInstance — exported so caller
// orchestrators that build their own specs can confirm the layer graph
// satisfies them at compile time.
export type BackendInstanceFactoryRequirements =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | DesktopObservability.DesktopBackendOutputLogFactory;

interface RegisteredInstance {
  readonly instance: DesktopBackendInstance;
  // None for the primary (which lives in the pool's own layer scope and
  // is never unregistered); Some for instances added via register, whose
  // scope unregister closes to stop them.
  readonly scope: Option.Option<Scope.Closeable>;
}

export const layer = Layer.effect(
  DesktopBackendPool,
  Effect.gen(function* () {
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    // Capture the services needed to build any future instance from the
    // pool's layer scope. register() runs `makeBackendInstance` against
    // a fresh child scope but reuses these services so the instance gets
    // the same FileSystem, spawner, HTTP client and log factory the
    // primary instance uses.
    const factoryContext = yield* Effect.context<BackendInstanceFactoryRequirements>();

    const primary = yield* DesktopBackendManager.makeBackendInstance({
      id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
      label: "Windows",
      configResolve: configuration.resolve,
      // Window creation errors propagating out of handleBackendReady are
      // swallowed here on purpose: they're logged by the window service
      // and we don't want a stuck splash window to block the readiness
      // callback (which would prevent restartAttempt from being reset).
      onReady: () => desktopWindow.handleBackendReady.pipe(Effect.catch(() => Effect.void)),
      onShutdown: () => desktopWindow.handleBackendNotReady,
    });

    const instancesRef = yield* SynchronizedRef.make<
      ReadonlyMap<BackendInstanceId, RegisteredInstance>
    >(
      new Map([
        [DesktopBackendManager.PRIMARY_INSTANCE_ID, { instance: primary, scope: Option.none() }],
      ]),
    );

    const register: DesktopBackendPoolShape["register"] = (spec) =>
      SynchronizedRef.modifyEffect(instancesRef, (current) => {
        if (current.has(spec.id)) {
          return Effect.fail(new DesktopBackendPoolInstanceAlreadyRegisteredError({ id: spec.id }));
        }
        return Effect.gen(function* () {
          const instanceScope = yield* Scope.make("sequential");
          const instance = yield* DesktopBackendManager.makeBackendInstance(spec).pipe(
            Scope.provide(instanceScope),
            Effect.provide(factoryContext),
          );
          const next = new Map(current);
          next.set(spec.id, { instance, scope: Option.some(instanceScope) });
          return [instance, next as ReadonlyMap<BackendInstanceId, RegisteredInstance>] as const;
        });
      });

    const unregister: DesktopBackendPoolShape["unregister"] = (id) =>
      Effect.gen(function* () {
        if (id === DesktopBackendManager.PRIMARY_INSTANCE_ID) {
          return yield* new DesktopBackendPoolCannotUnregisterPrimaryError();
        }
        // modifyEffect atomically pulls the entry out of the registry
        // and yields the scope handle; closing the scope below runs the
        // instance's auto-stop finalizer.
        const removed = yield* SynchronizedRef.modifyEffect(instancesRef, (current) => {
          const entry = current.get(id);
          if (entry === undefined) {
            return Effect.succeed([Option.none<Scope.Closeable>(), current] as const);
          }
          const next = new Map(current);
          next.delete(id);
          return Effect.succeed([
            entry.scope,
            next as ReadonlyMap<BackendInstanceId, RegisteredInstance>,
          ] as const);
        });
        yield* Option.match(removed, {
          onNone: () => Effect.void,
          onSome: (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
        });
      });

    return DesktopBackendPool.of({
      get: (id) =>
        SynchronizedRef.get(instancesRef).pipe(
          Effect.map((instances) => Option.fromNullishOr(instances.get(id)?.instance)),
        ),
      list: SynchronizedRef.get(instancesRef).pipe(
        Effect.map((instances) => Array.from(instances.values(), (entry) => entry.instance)),
      ),
      primary: Effect.succeed(primary),
      register,
      unregister,
    });
  }),
);

// Test layer for unit tests that want to assert against a known pool
// composition without standing up the full manager. Each provided
// instance is registered under its own id; the first one is also
// surfaced as `primary` so callers can stub a single-instance pool.
// `register` and `unregister` are stubbed to die so tests that
// accidentally exercise pool registration fail loudly instead of
// silently noop'ing.
export const layerTest = (
  instances: readonly DesktopBackendInstance[],
): Layer.Layer<DesktopBackendPool> =>
  Layer.effect(
    DesktopBackendPool,
    Effect.gen(function* () {
      if (instances.length === 0) {
        return yield* Effect.die("DesktopBackendPool.layerTest requires at least one instance");
      }
      const byId = new Map<BackendInstanceId, DesktopBackendInstance>(
        instances.map((instance) => [instance.id, instance] as const),
      );
      const primary = instances[0]!;
      return DesktopBackendPool.of({
        get: (id) => Effect.succeed(Option.fromNullishOr(byId.get(id))),
        list: Effect.succeed(Array.from(byId.values())),
        primary: Effect.succeed(primary),
        register: () => Effect.die("DesktopBackendPool.layerTest does not support register"),
        unregister: () => Effect.die("DesktopBackendPool.layerTest does not support unregister"),
      });
    }),
  );

# Effect.fn Refactor Checklist

Generated from a repo scan for non-test wrapper-style candidates matching either `=> Effect.gen(function* ...)` or `return Effect.gen(function* ...)`.

Refactor Method:

```ts
// Old
function old () {
    return Effect.gen(function* () {
        ...
    });
}

const old2 = () => Effect.gen(function* () {
    ...
});
```

```ts
// New
const new = Effect.fn('functionName')(function* () {
    ...
})
```

- Use `Effect.fn('name')(function* (input: Input): Effect.fn.Return<A, E, R> {})` to annotate the return type of the function if needed.

- The 2nd argument works as a pipe, and it gets the effect and input as arguments:

```ts
Effect.fn("name")(
  function* (input: Input): Effect.fn.Return<A, E, R> {},
  (effect, input) => Effect.catch(effect, (reason) => Effect.logWarning("Err", { input, reason })),
);
```

## Summary

- Total non-test candidates: `322`
- Status: completed for the original checklist scope.
- Follow-up exact `() => Effect.gen(...)` scan after completion also migrated `apps/server/src/terminal/Layers/Manager.ts`.

## Suggested Order

- [x] `apps/server/src/provider/Layers/ProviderService.ts`
- [x] `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- [x] `apps/server/src/provider/Layers/CodexAdapter.ts`
- [x] `apps/server/src/git/Layers/GitCore.ts`
- [x] `apps/server/src/git/Layers/GitManager.ts`
- [x] `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- [x] `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- [x] `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- [x] `apps/server/src/provider/Layers/EventNdjsonLogger.ts`
- [x] `Everything else`

## Checklist

### `apps/server/src/provider/Layers/ClaudeAdapter.ts` (`62`)

- [x] [buildUserMessageEffect](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L554)
- [x] [makeClaudeAdapter](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L913)
- [x] [startSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2414)
- [x] [sendTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2887)
- [x] [interruptTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2975)
- [x] [readThread](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2984)
- [x] [rollbackThread](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2990)
- [x] [stopSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3039)
- [x] Internal helpers and callback wrappers in this file

### `apps/server/src/git/Layers/GitCore.ts` (`58`)

- [x] [makeGitCore](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L513)
- [x] [handleTraceLine](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L324)
- [x] [emitCompleteLines](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L455)
- [x] [commit](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L1190)
- [x] [pushCurrentBranch](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L1223)
- [x] [pullCurrentBranch](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L1323)
- [x] [checkoutBranch](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitCore.ts#L1727)
- [x] Service methods and callback wrappers in this file

### `apps/server/src/git/Layers/GitManager.ts` (`28`)

- [x] [configurePullRequestHeadUpstream](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L387)
- [x] [materializePullRequestHeadBranch](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L428)
- [x] [findOpenPr](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L576)
- [x] [findLatestPr](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L602)
- [x] [runCommitStep](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L728)
- [x] [runPrStep](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L842)
- [x] [runFeatureBranchStep](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/GitManager.ts#L1106)
- [x] Remaining helpers and nested callback wrappers in this file

### `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (`25`)

- [x] [runProjectorForEvent](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L1161)
- [x] [applyProjectsProjection](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L357)
- [x] [applyThreadsProjection](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L415)
- [x] `Effect.forEach(..., threadId => Effect.gen(...))` callbacks around `L250`
- [x] `Effect.forEach(..., entry => Effect.gen(...))` callbacks around `L264`
- [x] `Effect.forEach(..., entry => Effect.gen(...))` callbacks around `L305`
- [x] Remaining apply helpers in this file

### `apps/server/src/provider/Layers/ProviderService.ts` (`24`)

- [x] [makeProviderService](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L134)
- [x] [recoverSessionForThread](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L196)
- [x] [resolveRoutableSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L255)
- [x] [startSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L284)
- [x] [sendTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L347)
- [x] [interruptTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L393)
- [x] [respondToRequest](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L411)
- [x] [respondToUserInput](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L430)
- [x] [stopSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L445)
- [x] [listSessions](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L466)
- [x] [rollbackConversation](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L516)
- [x] [runStopAll](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderService.ts#L538)

### `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (`14`)

- [x] [finalizeAssistantMessage](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L680)
- [x] [upsertProposedPlan](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L722)
- [x] [finalizeBufferedProposedPlan](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L761)
- [x] [clearTurnStateForSession](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L800)
- [x] [processRuntimeEvent](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L908)
- [x] Nested callback wrappers in this file

### `apps/server/src/provider/Layers/CodexAdapter.ts` (`12`)

- [x] [makeCodexAdapter](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexAdapter.ts#L1317)
- [x] [sendTurn](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexAdapter.ts#L1399)
- [x] [writeNativeEvent](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexAdapter.ts#L1546)
- [x] [listener](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexAdapter.ts#L1555)
- [x] Remaining nested callback wrappers in this file

### `apps/server/src/checkpointing/Layers/CheckpointStore.ts` (`10`)

- [x] [captureCheckpoint](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L89)
- [x] [restoreCheckpoint](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L183)
- [x] [diffCheckpoints](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L220)
- [x] [deleteCheckpointRefs](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointStore.ts#L252)
- [x] Nested callback wrappers in this file

### `apps/server/src/provider/Layers/EventNdjsonLogger.ts` (`9`)

- [x] [toLogMessage](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L77)
- [x] [makeThreadWriter](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L102)
- [x] [makeEventNdjsonLogger](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L174)
- [x] [write](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L231)
- [x] [close](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L247)
- [x] Flush and writer-resolution callback wrappers in this file

### `apps/server/scripts/cli.ts` (`8`)

- [x] Command handlers around [cli.ts](/Users/julius/Development/Work/codething-mvp/apps/server/scripts/cli.ts#L125)
- [x] Command handlers around [cli.ts](/Users/julius/Development/Work/codething-mvp/apps/server/scripts/cli.ts#L170)
- [x] Resource callbacks around [cli.ts](/Users/julius/Development/Work/codething-mvp/apps/server/scripts/cli.ts#L221)
- [x] Resource callbacks around [cli.ts](/Users/julius/Development/Work/codething-mvp/apps/server/scripts/cli.ts#L239)

### `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` (`7`)

- [x] [processEnvelope](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L64)
- [x] [dispatch](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L218)
- [x] Catch/stream callback wrappers around [OrchestrationEngine.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L162)
- [x] Catch/stream callback wrappers around [OrchestrationEngine.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L200)

### `apps/server/src/orchestration/projector.ts` (`5`)

- [x] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L242)
- [x] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L336)
- [x] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L397)
- [x] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L446)
- [x] `switch` branch wrapper at [projector.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/projector.ts#L478)

### Smaller clusters

- [x] [packages/shared/src/DrainableWorker.ts](/Users/julius/Development/Work/codething-mvp/packages/shared/src/DrainableWorker.ts) (`4`)
- [x] [apps/server/src/wsServer/pushBus.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/wsServer/pushBus.ts) (`4`)
- [x] [apps/server/src/wsServer.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/wsServer.ts) (`4`)
- [x] [apps/server/src/provider/Layers/ProviderRegistry.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderRegistry.ts) (`4`)
- [x] [apps/server/src/persistence/Layers/Sqlite.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/persistence/Layers/Sqlite.ts) (`4`)
- [x] [apps/server/src/orchestration/Layers/ProviderCommandReactor.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) (`4`)
- [x] [apps/server/src/main.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/main.ts) (`4`)
- [x] [apps/server/src/keybindings.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/keybindings.ts) (`4`)
- [x] [apps/server/src/git/Layers/CodexTextGeneration.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/CodexTextGeneration.ts) (`4`)
- [x] [apps/server/src/serverLayers.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/serverLayers.ts) (`3`)
- [x] [apps/server/src/telemetry/Layers/AnalyticsService.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/telemetry/Layers/AnalyticsService.ts) (`2`)
- [x] [apps/server/src/telemetry/Identify.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/telemetry/Identify.ts) (`2`)
- [x] [apps/server/src/provider/Layers/ProviderAdapterRegistry.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts) (`2`)
- [x] [apps/server/src/provider/Layers/CodexProvider.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/CodexProvider.ts) (`2`)
- [x] [apps/server/src/provider/Layers/ClaudeProvider.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/Layers/ClaudeProvider.ts) (`2`)
- [x] [apps/server/src/persistence/NodeSqliteClient.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/persistence/NodeSqliteClient.ts) (`2`)
- [x] [apps/server/src/persistence/Migrations.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/persistence/Migrations.ts) (`2`)
- [x] [apps/server/src/open.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/open.ts) (`2`)
- [x] [apps/server/src/git/Layers/ClaudeTextGeneration.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/git/Layers/ClaudeTextGeneration.ts) (`2`)
- [x] [apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts) (`2`)
- [x] [apps/server/src/provider/makeManagedServerProvider.ts](/Users/julius/Development/Work/codething-mvp/apps/server/src/provider/makeManagedServerProvider.ts) (`1`)

```

```

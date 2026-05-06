import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { PiSettings, TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { Effect, Schema } from "effect";
import { join } from "node:path";

import { resolvePiAgentDir } from "../provider/Layers/PiProvider.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

function findPiModel(settings: PiSettings, modelSelection: ModelSelection) {
  const modelSlug = modelSelection.model.trim();
  if (!modelSlug || modelSlug === "auto") {
    return undefined;
  }
  const agentDir = resolvePiAgentDir(settings);
  const authStorage = AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
  const modelRegistry = ModelRegistry.create(
    authStorage,
    agentDir ? join(agentDir, "models.json") : undefined,
  );
  const [provider, modelId] = modelSlug.split("/", 2);
  return provider && modelId ? modelRegistry.find(provider, modelId) : undefined;
}

function extractLastAssistantText(session: AgentSession): string {
  for (const message of session.messages.toReversed()) {
    if (message.role !== "assistant") {
      continue;
    }
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
  }
  return "";
}

const toTextGenerationError = (operation: string, cause: unknown) =>
  new TextGenerationError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export const makePiTextGeneration = (settings: PiSettings) =>
  Effect.succeed({
    generateCommitMessage: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { prompt, outputSchema } = buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch ?? false,
          });
          const generated = await runPiJson({
            settings,
            operation: "generateCommitMessage",
            cwd: input.cwd,
            prompt,
            outputSchema,
            modelSelection: input.modelSelection,
          });
          return {
            subject: sanitizeCommitSubject(requireGeneratedField(generated, "subject")),
            body: requireGeneratedField(generated, "body").trim(),
            ...(input.includeBranch && generated.branch
              ? { branch: sanitizeBranchFragment(generated.branch) }
              : {}),
          };
        },
        catch: (cause) => toTextGenerationError("generateCommitMessage", cause),
      }),
    generatePrContent: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { prompt, outputSchema } = buildPrContentPrompt({
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            commitSummary: input.commitSummary,
            diffSummary: input.diffSummary,
            diffPatch: input.diffPatch,
          });
          const generated = await runPiJson({
            settings,
            operation: "generatePrContent",
            cwd: input.cwd,
            prompt,
            outputSchema,
            modelSelection: input.modelSelection,
          });
          return {
            title: sanitizePrTitle(requireGeneratedField(generated, "title")),
            body: requireGeneratedField(generated, "body").trim(),
          };
        },
        catch: (cause) => toTextGenerationError("generatePrContent", cause),
      }),
    generateBranchName: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { prompt, outputSchema } = buildBranchNamePrompt({
            message: input.message,
            attachments: input.attachments,
          });
          const generated = await runPiJson({
            settings,
            operation: "generateBranchName",
            cwd: input.cwd,
            prompt,
            outputSchema,
            modelSelection: input.modelSelection,
          });
          return { branch: sanitizeBranchFragment(requireGeneratedField(generated, "branch")) };
        },
        catch: (cause) => toTextGenerationError("generateBranchName", cause),
      }),
    generateThreadTitle: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { prompt, outputSchema } = buildThreadTitlePrompt({
            message: input.message,
            attachments: input.attachments,
          });
          const generated = await runPiJson({
            settings,
            operation: "generateThreadTitle",
            cwd: input.cwd,
            prompt,
            outputSchema,
            modelSelection: input.modelSelection,
          });
          return { title: sanitizeThreadTitle(requireGeneratedField(generated, "title")) };
        },
        catch: (cause) => toTextGenerationError("generateThreadTitle", cause),
      }),
  } satisfies TextGenerationShape);

async function runPiJson(input: {
  readonly settings: PiSettings;
  readonly operation: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: Schema.Top;
  readonly modelSelection: ModelSelection;
}): Promise<Record<string, string>> {
  const agentDir = resolvePiAgentDir(input.settings);
  const model = findPiModel(input.settings, input.modelSelection);
  const { session } = await createAgentSession({
    cwd: input.cwd,
    ...(agentDir ? { agentDir } : {}),
    sessionManager: SessionManager.inMemory(input.cwd),
    ...(model ? { model } : {}),
  });
  try {
    await session.prompt(input.prompt, { source: "rpc" });
    const text = extractLastAssistantText(session);
    const json = extractJsonObject(text);
    return Schema.decodeUnknownPromise(Schema.Record(Schema.String, Schema.String))(
      JSON.parse(json),
    );
  } finally {
    session.dispose();
  }
}

function requireGeneratedField(generated: Record<string, string>, key: string): string {
  const value = generated[key]?.trim();
  if (!value) {
    throw new Error(`Pi text generation did not return '${key}'.`);
  }
  return value;
}

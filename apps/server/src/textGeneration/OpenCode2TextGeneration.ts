/**
 * OpenCode2TextGeneration — structured text-generation for the OpenCode 2
 * (`opencode2`) preview API.
 *
 * Runs one-shot: a fresh session is created in the request cwd, the requested
 * model is switched in, the prompt is admitted through the inbox, and the
 * `session.text.delta` / `session.execution.*` SSE events are folded to the
 * final assistant text. The managed server child (or the external connection)
 * lives only for the duration of the request.
 *
 * @module textGeneration/OpenCode2TextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type OpenCode2Settings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  makeOpenCode2ApiClient,
  OpenCode2Runtime,
  openCode2RuntimeErrorDetail,
  parseOpenCode2ModelSlug,
  toOpenCode2FileParts,
  type OpenCode2ServerConnection,
  type OpenCode2SseMessage,
} from "../provider/opencode2Runtime.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const OPENCODE2_TEXT_GENERATION_TIMEOUT_MS = 120_000;

const OpenCode2TextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
]);
type OpenCode2TextGenerationOperation = typeof OpenCode2TextGenerationOperation.Type;

function toOpenCode2TextGenerationError(
  operation: OpenCode2TextGenerationOperation,
  detail: string,
  cause?: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Extract the parsed envelope carried by an SSE message produced by
 * {@link OpenCode2Runtime.streamOpenCode2Events}: `{ type, data, ... }`.
 */
function openCode2Envelope(message: OpenCode2SseMessage): {
  readonly type: string;
  readonly payload: Record<string, unknown>;
} {
  const envelope = message.data as { readonly type?: unknown; readonly data?: unknown } | null;
  const type = typeof envelope?.type === "string" ? envelope.type : "";
  const payload =
    envelope?.data !== null && typeof envelope?.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : {};
  return { type, payload };
}

function isOpenCode2ExecutionTerminal(message: OpenCode2SseMessage, sessionId: string): boolean {
  const { type, payload } = openCode2Envelope(message);
  if (payload.sessionID !== sessionId) {
    return false;
  }
  return (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  );
}

function openCode2AssistantDelta(message: OpenCode2SseMessage, sessionId: string): string {
  const { type, payload } = openCode2Envelope(message);
  if (type !== "session.text.delta" || payload.sessionID !== sessionId) {
    return "";
  }
  return typeof payload.delta === "string" ? payload.delta : "";
}

export const makeOpenCode2TextGeneration = Effect.fn("makeOpenCode2TextGeneration")(function* (
  openCode2Settings: OpenCode2Settings,
  environment?: NodeJS.ProcessEnv,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const openCode2Runtime = yield* OpenCode2Runtime;
  const resolvedEnvironment = environment ?? process.env;

  const runOpenCode2Json = Effect.fn("runOpenCode2Json")(function* <S extends Schema.Top>(input: {
    readonly operation: OpenCode2TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const parsedModel = parseOpenCode2ModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* toOpenCode2TextGenerationError(
        input.operation,
        "OpenCode 2 model selection must use the 'provider/model' format.",
      );
    }
    const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
    const fileParts = toOpenCode2FileParts({
      attachments: input.attachments,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        }),
    });

    const toOpError = (cause: unknown): TextGenerationError =>
      Schema.is(TextGenerationError)(cause)
        ? cause
        : toOpenCode2TextGenerationError(
            input.operation,
            openCode2RuntimeErrorDetail(cause),
            cause,
          );

    const runAgainstConnection = Effect.fn("runOpenCode2Json.runAgainstConnection")(function* (
      connection: OpenCode2ServerConnection,
    ) {
      const api = makeOpenCode2ApiClient({
        connection,
        request: openCode2Runtime.request,
      });

      const session = yield* api
        .createSession(input.cwd, `T3 Code ${input.operation}`)
        .pipe(Effect.mapError(toOpError));
      yield* api
        .switchModel(session.id, {
          id: parsedModel.modelID,
          providerID: parsedModel.providerID,
          ...(variant ? { variant } : {}),
        })
        .pipe(Effect.mapError(toOpError));

      // Open the event stream before prompting so no delta is missed; the
      // response body queues while the prompt is admitted.
      const stream = yield* openCode2Runtime
        .streamOpenCode2Events({ connection })
        .pipe(Effect.mapError(toOpError));
      yield* api
        .promptSession(session.id, input.prompt, fileParts, "steer")
        .pipe(Effect.mapError(toOpError));

      const textOption = yield* stream
        .pipe(
          Stream.takeWhile((message) => !isOpenCode2ExecutionTerminal(message, session.id)),
          Stream.runFold(
            () => "",
            (acc: string, message) => acc + openCode2AssistantDelta(message, session.id),
          ),
          Effect.timeoutOption(OPENCODE2_TEXT_GENERATION_TIMEOUT_MS),
        )
        .pipe(Effect.mapError(toOpError));
      if (Option.isNone(textOption)) {
        return yield* toOpenCode2TextGenerationError(
          input.operation,
          `OpenCode 2 text generation timed out after ${OPENCODE2_TEXT_GENERATION_TIMEOUT_MS}ms.`,
        );
      }
      const rawText = textOption.value.trim();
      if (rawText.length === 0) {
        return yield* toOpenCode2TextGenerationError(
          input.operation,
          "OpenCode 2 returned empty output.",
        );
      }
      return rawText;
    });

    const serverUrl = openCode2Settings.serverUrl.trim();
    let rawOutput: string;
    if (serverUrl.length > 0) {
      const password = openCode2Settings.serverPassword.trim();
      if (password.length === 0) {
        return yield* toOpenCode2TextGenerationError(
          input.operation,
          "An external OpenCode 2 server URL is configured but no server password.",
        );
      }
      rawOutput = yield* runAgainstConnection({
        url: serverUrl,
        password,
        external: true,
        exitCode: null,
      });
    } else {
      rawOutput = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* openCode2Runtime.connectToOpenCode2Server({
            binaryPath: openCode2Settings.binaryPath,
            environment: resolvedEnvironment,
          });
          return yield* runAgainstConnection(connection);
        }),
      ).pipe(
        Effect.mapError((cause) =>
          Schema.is(TextGenerationError)(cause)
            ? cause
            : toOpenCode2TextGenerationError(
                input.operation,
                openCode2RuntimeErrorDetail(cause),
                cause,
              ),
        ),
      );
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            toOpenCode2TextGenerationError(
              input.operation,
              "OpenCode 2 returned invalid structured output.",
              cause,
            ),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OpenCode2TextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runOpenCode2Json({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OpenCode2TextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runOpenCode2Json({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OpenCode2TextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCode2Json({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OpenCode2TextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCode2Json({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});

import type { UserInputQuestion } from "@t3tools/contracts";
import { Schema } from "effect";

const CursorAskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const CursorAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(CursorAskQuestionOption),
  allowMultiple: Schema.Boolean,
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  questions: Schema.Array(CursorAskQuestion),
});

const CursorTodoStatus = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("in_progress"),
  Schema.Literal("completed"),
  Schema.Literal("cancelled"),
]);

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  status: CursorTodoStatus,
});

const CursorPlanPhase = Schema.Struct({
  name: Schema.optional(Schema.String),
  todos: Schema.Array(CursorTodo),
});

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(CursorTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(CursorPlanPhase)),
});

export const CursorUpdateTodosRequest = Schema.Unknown;

export function extractAskQuestions(
  params: typeof CursorAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function extractPlanMarkdown(params: typeof CursorCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(Cursor did not supply plan text.)";
}

export function extractTodosAsPlan(params: typeof CursorUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  if (typeof params !== "object" || params === null) {
    return { plan: [] };
  }
  const record = params as {
    readonly todos?: ReadonlyArray<{
      readonly content?: string;
      readonly title?: string;
      readonly status?: string;
    }>;
    readonly items?: ReadonlyArray<{
      readonly content?: string;
      readonly title?: string;
      readonly status?: string;
    }>;
  };
  const todos = record.todos ?? record.items;
  if (!todos) {
    return { plan: [] };
  }
  const plan = todos.map((t, i) => {
    const step =
      typeof t?.content === "string"
        ? t.content
        : typeof t?.title === "string"
          ? t.title
          : `Step ${i + 1}`;
    const status: "pending" | "inProgress" | "completed" =
      t?.status === "completed"
        ? "completed"
        : t?.status === "in_progress" || t?.status === "inProgress"
          ? "inProgress"
          : "pending";
    return { step, status };
  });
  return { plan };
}

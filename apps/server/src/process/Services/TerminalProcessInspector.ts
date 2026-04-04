import { ServiceMap, Schema } from "effect";
import type { Effect } from "effect";

export class TerminalProcessInspectionError extends Schema.TaggedErrorClass<TerminalProcessInspectionError>()(
  "TerminalProcessInspectionError",
  {
    operation: Schema.String,
    terminalPid: Schema.Int,
    command: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.operation} failed for terminal pid ${this.terminalPid}: ${this.detail}`;
  }
}

export interface TerminalSubprocessActivity {
  hasRunningSubprocess: boolean;
  runningPorts: number[];
}

export type TerminalSubprocessInspector = (
  terminalPid: number,
) => Effect.Effect<TerminalSubprocessActivity, TerminalProcessInspectionError>;

export interface TerminalProcessInspectorShape {
  readonly inspect: (
    terminalPid: number,
  ) => Effect.Effect<TerminalSubprocessActivity, TerminalProcessInspectionError>;
}

export class TerminalProcessInspector extends ServiceMap.Service<
  TerminalProcessInspector,
  TerminalProcessInspectorShape
>()("t3/process/Services/TerminalProcessInspector") {}

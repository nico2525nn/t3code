import type { ClaudeModelSelection } from "@t3tools/contracts";

export function resolveClaudeApiModelId(modelSelection: ClaudeModelSelection): string {
  switch (modelSelection.options?.contextWindow) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}

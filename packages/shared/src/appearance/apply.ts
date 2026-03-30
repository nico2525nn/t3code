import type { ThemeDocument, ThemeVariant } from "@t3tools/contracts/appearanceTheme";
import { deriveThemeCssVariables, type ThemeCssVariableMap } from "./derive";

export interface CssVariableTarget {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

export function applyThemeCssVariables(
  target: CssVariableTarget,
  variables: ThemeCssVariableMap,
): ReadonlyArray<keyof ThemeCssVariableMap> {
  const applied: Array<keyof ThemeCssVariableMap> = [];
  for (const [name, value] of Object.entries(variables) as Array<
    [keyof ThemeCssVariableMap, string]
  >) {
    target.setProperty(name, value);
    applied.push(name);
  }
  return applied;
}

export function applyThemeVariant(
  target: CssVariableTarget,
  themeVariant: ThemeVariant,
): ReadonlyArray<keyof ThemeCssVariableMap> {
  return applyThemeCssVariables(target, deriveThemeCssVariables(themeVariant));
}

export function applyThemeDocumentStyles(
  target: CssVariableTarget,
  themeDocument: ThemeDocument,
): void {
  target.setProperty("--radius", themeDocument.radius);
  target.setProperty("font-size", themeDocument.fontSize);
}

export function clearThemeCssVariables(
  target: CssVariableTarget,
  variableNames: ReadonlyArray<keyof ThemeCssVariableMap>,
): void {
  for (const variableName of variableNames) {
    target.removeProperty(variableName);
  }
}

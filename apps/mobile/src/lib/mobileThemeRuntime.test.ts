import { describe, expect, it } from "vite-plus/test";

import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  themeAppearance: "light",
  themeIds: { light: "t3-code", dark: "t3-code" },
  themeMode: "system",
};

describe("mobileThemeRuntime", () => {
  it("maps every palette and appearance to its registered theme", () => {
    expect(getMobileUniwindThemeName("t3-chat", "dark")).toBe("t3-chat-dark");
  });

  it("hydrates text variables with the active theme last and does not animate startup", () => {
    const operations = createMobileThemeRuntimeOperations(null, initialState, {
      transition: "circle-center",
    });
    const variableOperations = operations.filter(
      (operation) => operation.kind === "update-text-variables",
    );

    expect(variableOperations).toHaveLength(14);
    expect(variableOperations.at(-1)?.themeName).toBe("t3-code-light");
    expect(operations.at(-1)).toEqual({
      kind: "set-theme",
      appearance: "light",
      themeMode: "system",
      themeName: "t3-code-light",
      transition: null,
    });
  });

  it("switches a visible palette through the Pro theme transition", () => {
    const operations = createMobileThemeRuntimeOperations(
      initialState,
      {
        ...initialState,
        themeIds: { ...initialState.themeIds, light: "ocean" },
      },
      { transition: "slide-right-to-left" },
    );

    expect(operations).toEqual([
      {
        kind: "set-theme",
        appearance: "light",
        themeMode: "system",
        themeName: "ocean-light",
        transition: "slide-right-to-left",
      },
    ]);
  });

  it("does no native work for an inactive palette selection", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeIds: { ...initialState.themeIds, dark: "ocean" },
    });

    expect(operations).toEqual([]);
  });

  it("uses the selected dark palette when the visible appearance changes", () => {
    const operations = createMobileThemeRuntimeOperations(
      initialState,
      {
        ...initialState,
        themeAppearance: "dark",
        themeIds: { light: "t3-code", dark: "grove" },
        themeMode: "dark",
      },
      { transition: "blur" },
    );

    expect(operations).toEqual([
      {
        kind: "set-theme",
        appearance: "dark",
        themeMode: "dark",
        themeName: "grove-dark",
        transition: "blur",
      },
    ]);
  });

  it("updates only native appearance when the palette and appearance stay the same", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeMode: "light",
    });

    expect(operations).toEqual([
      { kind: "set-appearance-mode", appearance: "light", themeMode: "light" },
    ]);
  });

  it("updates text variables for every theme without switching palettes", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      baseFontSize: 18,
    });

    expect(operations).toHaveLength(14);
    expect(operations.every((operation) => operation.kind === "update-text-variables")).toBe(true);
    expect(operations.at(-1)).toMatchObject({
      kind: "update-text-variables",
      themeName: "t3-code-light",
    });
  });

  it("does no native work when persistence echoes an already-applied state", () => {
    expect(createMobileThemeRuntimeOperations(initialState, initialState)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { deriveMainSettingsFields } from "./MainSettingsForm";

describe("MainSettingsForm helpers", () => {
  it("derives the main settings rows from schema annotations", () => {
    expect(deriveMainSettingsFields().map((field) => field.key)).toEqual([
      "theme",
      "timestampFormat",
      "diffWordWrap",
      "diffIgnoreWhitespace",
      "enableAssistantStreaming",
      "autoOpenPlanSidebar",
      "defaultThreadEnvMode",
      "addProjectBaseDirectory",
      "confirmThreadArchive",
      "confirmThreadDelete",
      "textGenerationModelSelection",
    ]);
  });

  it("reads select options and descriptions from annotations", () => {
    const timestampFormat = deriveMainSettingsFields().find(
      (field) => field.key === "timestampFormat",
    );

    expect(timestampFormat).toMatchObject({
      control: "select",
      label: "Time format",
      description: "System default follows your browser or OS clock preference.",
      options: [
        { value: "locale", label: "System default" },
        { value: "12-hour", label: "12-hour" },
        { value: "24-hour", label: "24-hour" },
      ],
    });
  });
});

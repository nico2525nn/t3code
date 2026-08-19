import { describe, expect, it } from "vite-plus/test";

import { buildMobilePluginCommandItems } from "./plugin-command-menu";

describe("buildMobilePluginCommandItems", () => {
  it("renders only matching mobile command contributions", () => {
    const items = buildMobilePluginCommandItems(
      [
        {
          id: "plugin.mobile-status",
          label: "Check status",
          description: "Verify the runtime",
          surfaces: ["mobile"],
        },
        {
          id: "plugin.web-only",
          label: "Web only",
          surfaces: ["web"],
        },
      ],
      "status",
    );

    expect(items.map((item) => item.id)).toEqual(["plugin-command:plugin.mobile-status"]);
    expect(items[0]?.type).toBe("plugin-command");
  });
});

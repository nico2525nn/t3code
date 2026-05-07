import { describe, expect, it } from "vitest";

import { toPiJsonValue } from "./jsonSafe.ts";

describe("toPiJsonValue", () => {
  it("removes non-JSON object fields before Pi metadata crosses RPC", () => {
    const cyclic: Record<string, unknown> = { label: "cycle" };
    cyclic.self = cyclic;

    expect(
      toPiJsonValue({
        path: "/Users/davis/.pi/agent/extensions/pi-mcp/src/index.ts",
        source: "local",
        baseDir: undefined,
        nested: {
          enabled: true,
          missing: undefined,
          callback: () => undefined,
        },
        list: [undefined, Number.NaN, "tool"],
        cyclic,
      }),
    ).toEqual({
      path: "/Users/davis/.pi/agent/extensions/pi-mcp/src/index.ts",
      source: "local",
      nested: {
        enabled: true,
      },
      list: [null, null, "tool"],
      cyclic: {
        label: "cycle",
      },
    });
  });
});

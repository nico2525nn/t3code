import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { findOpenCode2EventData } from "./OpenCode2Adapter.ts";

describe("findOpenCode2EventData", () => {
  it("extracts the payload object from a V2 SSE envelope", () => {
    const envelope = {
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", delta: "hello" },
    };
    NodeAssert.deepEqual(findOpenCode2EventData(envelope), {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      delta: "hello",
    });
  });

  it("returns an empty record for missing or non-object data", () => {
    NodeAssert.deepEqual(findOpenCode2EventData({ type: "heartbeat" }), {});
    NodeAssert.deepEqual(findOpenCode2EventData({ type: "x", data: "string" }), {});
    NodeAssert.deepEqual(findOpenCode2EventData({ type: "x", data: null }), {});
  });
});

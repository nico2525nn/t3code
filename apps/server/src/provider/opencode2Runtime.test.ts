import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildAuthorizationHeader,
  buildOpenCode2Url,
  decodeOpenCode2SseMessage,
  parseOpenCode2ModelSlug,
  parseOpenCode2ServeOutput,
  parseOpenCode2SseBuffer,
} from "./opencode2Runtime.ts";

describe("parseOpenCode2ServeOutput", () => {
  it("extracts url and password from serve stdout", () => {
    const stdout = ["server listening on http://127.0.0.1:49123", "server password abcDEF123"].join(
      "\n",
    );
    NodeAssert.deepEqual(parseOpenCode2ServeOutput(stdout), {
      url: "http://127.0.0.1:49123",
      password: "abcDEF123",
    });
  });

  it("tolerates missing password and interleaved log lines", () => {
    const stdout = "starting...\nserver listening on http://127.0.0.1:9\n";
    NodeAssert.deepEqual(parseOpenCode2ServeOutput(stdout), {
      url: "http://127.0.0.1:9",
    });
  });

  it("returns empty when nothing is emitted", () => {
    NodeAssert.deepEqual(parseOpenCode2ServeOutput(""), {});
  });
});

describe("parseOpenCode2SseBuffer", () => {
  it("splits frames across chunk boundaries", () => {
    const first = parseOpenCode2SseBuffer("", 'data: {"a":1}\n\n');
    NodeAssert.deepEqual(first.frames, ['{"a":1}']);
    NodeAssert.equal(first.remainder, "");

    const second = parseOpenCode2SseBuffer(first.remainder, 'data: {"b":2}\n');
    NodeAssert.deepEqual(second.frames, []);
    NodeAssert.equal(second.remainder, 'data: {"b":2}\n');

    const third = parseOpenCode2SseBuffer(second.remainder, "\n");
    NodeAssert.deepEqual(third.frames, ['{"b":2}']);
    NodeAssert.equal(third.remainder, "");
  });

  it("ignores heartbeat comment frames", () => {
    const result = parseOpenCode2SseBuffer("", ": heartbeat\n\n");
    NodeAssert.deepEqual(result.frames, []);
  });

  it("joins multi-line data payloads", () => {
    // SSE spec: consecutive `data:` lines are joined with a single newline.
    const frame = 'data: {"type":\ndata: "a"}\n\n';
    const result = parseOpenCode2SseBuffer("", frame);
    NodeAssert.equal(result.frames.length, 1);
    const decoded = decodeOpenCode2SseMessage(result.frames[0]!);
    NodeAssert.ok(decoded);
    NodeAssert.equal((decoded.data as { type: string }).type, "a");
  });
});

describe("decodeOpenCode2SseMessage", () => {
  it("decodes a JSON event envelope", () => {
    const message = decodeOpenCode2SseMessage(
      '{"id":"evt_x","type":"session.text.delta","data":{}}',
    );
    NodeAssert.deepEqual(message, {
      data: { id: "evt_x", type: "session.text.delta", data: {} },
    });
  });

  it("returns undefined for non-JSON frames", () => {
    NodeAssert.equal(decodeOpenCode2SseMessage("not json"), undefined);
  });
});

describe("parseOpenCode2ModelSlug", () => {
  it("splits provider/model slugs", () => {
    NodeAssert.deepEqual(parseOpenCode2ModelSlug("opencode-go/glm-5.3"), {
      providerID: "opencode-go",
      modelID: "glm-5.3",
    });
  });

  it("rejects malformed slugs", () => {
    NodeAssert.equal(parseOpenCode2ModelSlug(null), null);
    NodeAssert.equal(parseOpenCode2ModelSlug("nope"), null);
    NodeAssert.equal(parseOpenCode2ModelSlug("/leading"), null);
    NodeAssert.equal(parseOpenCode2ModelSlug("trailing/"), null);
  });
});

describe("buildOpenCode2Url", () => {
  it("joins a base URL and path", () => {
    NodeAssert.equal(
      buildOpenCode2Url("http://127.0.0.1:4096/", "/api/health"),
      "http://127.0.0.1:4096/api/health",
    );
  });

  it("appends query params", () => {
    NodeAssert.equal(
      buildOpenCode2Url("http://127.0.0.1:9", "/api/model", { limit: "5" }),
      "http://127.0.0.1:9/api/model?limit=5",
    );
  });
});

describe("buildAuthorizationHeader", () => {
  it("builds a Basic auth header for the opencode user", () => {
    const expected = `Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`;
    NodeAssert.equal(buildAuthorizationHeader("secret"), expected);
  });
});

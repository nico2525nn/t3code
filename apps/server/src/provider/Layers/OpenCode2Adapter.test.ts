import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  extractOpenCode2FormCandidates,
  findOpenCode2EventData,
  openCode2FormToQuestions,
  toOpenCode2FormAnswer,
} from "./OpenCode2Adapter.ts";

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

const sampleForm = {
  id: "frm_01hx",
  sessionID: "ses_1",
  title: "Pick an option",
  fields: [
    { key: "str", type: "string", title: "Name", description: "Your name", required: true },
    {
      key: "pick",
      type: "multiselect",
      title: "Pick",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    { key: "flag", type: "boolean", title: "Flag" },
  ],
};

describe("openCode2FormToQuestions", () => {
  it("maps a V2 form into T3 user-input questions", () => {
    const questions = openCode2FormToQuestions(sampleForm);
    NodeAssert.equal(questions.length, 3);
    NodeAssert.equal(questions[0]?.id, "str");
    NodeAssert.equal(questions[0]?.header, "Name");
    NodeAssert.equal(questions[0]?.question, "Your name");
    NodeAssert.deepEqual(questions[1]?.options, [
      { label: "A", description: "" },
      { label: "B", description: "" },
    ]);
    NodeAssert.equal(questions[1]?.multiSelect, true);
  });
});

describe("toOpenCode2FormAnswer", () => {
  it("coerces values to the V2 form field types", () => {
    const answer = toOpenCode2FormAnswer(sampleForm, {
      str: "nico",
      pick: ["a"],
      flag: "true",
    });
    NodeAssert.deepEqual(answer, { str: "nico", pick: ["a"], flag: true });
  });

  it("ignores fields the user did not answer", () => {
    const answer = toOpenCode2FormAnswer(sampleForm, { pick: "b" });
    NodeAssert.deepEqual(answer, { pick: ["b"] });
  });
});

describe("extractOpenCode2FormCandidates", () => {
  it("accepts a bare form payload", () => {
    const forms = extractOpenCode2FormCandidates(sampleForm as unknown as Record<string, unknown>);
    NodeAssert.equal(forms.length, 1);
    NodeAssert.equal(forms[0]?.id, "frm_01hx");
  });

  it("accepts a data-wrapped or batch payload", () => {
    const wrapped = extractOpenCode2FormCandidates({ data: sampleForm });
    NodeAssert.equal(wrapped.length, 1);

    const batch = extractOpenCode2FormCandidates({ forms: [sampleForm, sampleForm] });
    NodeAssert.equal(batch.length, 1);
  });

  it("ignores non-form payloads", () => {
    NodeAssert.deepEqual(extractOpenCode2FormCandidates({ type: "heartbeat" }), []);
    NodeAssert.deepEqual(extractOpenCode2FormCandidates({ id: "not-a-form" }), []);
  });
});

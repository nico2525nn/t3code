import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { encodePrettyJsonEffect } from "./schemaJson";

it.effect("encodePrettyJsonEffect writes indented JSON", () =>
  Effect.gen(function* () {
    const encodePrettyJson = encodePrettyJsonEffect(
      Schema.Struct({
        provider: Schema.String,
        options: Schema.Struct({
          enabled: Schema.Boolean,
        }),
      }),
    );

    const encoded = yield* encodePrettyJson({
      provider: "codex",
      options: {
        enabled: true,
      },
    });

    assert.strictEqual(
      encoded,
      `{
  "provider": "codex",
  "options": {
    "enabled": true
  }
}`,
    );
  }),
);

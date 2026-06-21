import { assert, describe, it } from "@effect/vitest";

import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";

describe("environment HTTP common errors", () => {
  it("derives messages from structural diagnostics", () => {
    assert.equal(
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_scope",
        traceId: "trace-request",
      }).message,
      "Environment request rejected with invalid_request (invalid_scope; trace trace-request).",
    );
    assert.equal(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-auth",
      }).message,
      "Environment authentication rejected with auth_invalid (invalid_credential; trace trace-auth).",
    );
    assert.equal(
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "access:read",
        traceId: "trace-scope",
      }).message,
      "Environment authorization requires scope access:read (insufficient_scope; trace trace-scope).",
    );
    assert.equal(
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId: "trace-forbidden",
      }).message,
      "Environment operation rejected with operation_forbidden (current_session_revoke_not_allowed; trace trace-forbidden).",
    );
    assert.equal(
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "access_token_issuance_failed",
        traceId: "trace-internal",
      }).message,
      "Environment request failed with internal_error (access_token_issuance_failed; trace trace-internal).",
    );
  });
});

import * as Schema from "effect/Schema";

/**
 * Tracks which T3 Connect accounts have completed (or dismissed) the
 * post-sign-in onboarding wizard, so it is shown at most once per account per
 * browser.
 */
export const CONNECT_ONBOARDING_STORAGE_KEY = "t3code:connect-onboarding:v1";

export const ConnectOnboardingStateSchema = Schema.Struct({
  completedAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingState = typeof ConnectOnboardingStateSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_STATE: ConnectOnboardingState = {
  completedAccounts: [],
};

import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { loadPreferences, savePreferencesPatch } from "../../lib/storage";
import { appAtomRegistry } from "../../state/atom-registry";

// Signals RootStackLayout (inside the navigation tree) that an in-session
// sign-in just completed for an account that has not seen the T3 Connect
// onboarding sheet yet. Holds the account id so a sign-out between the request
// and the navigation cannot present the sheet for the wrong account.
const connectOnboardingRequestAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connect-onboarding-request"),
);

/**
 * Requests the onboarding sheet for the given account unless it already
 * completed (or skipped) onboarding on this device.
 */
export async function requestConnectOnboardingIfNeeded(accountId: string): Promise<void> {
  const preferences = await loadPreferences();
  if (preferences.connectOnboardingCompletedAccounts?.includes(accountId)) {
    return;
  }
  appAtomRegistry.set(connectOnboardingRequestAtom, accountId);
}

export function clearConnectOnboardingRequest(): void {
  appAtomRegistry.set(connectOnboardingRequestAtom, null);
}

/** Persists that the account saw the sheet, so it never nags twice. */
export async function markConnectOnboardingCompleted(accountId: string): Promise<void> {
  const preferences = await loadPreferences();
  const completed = preferences.connectOnboardingCompletedAccounts ?? [];
  if (completed.includes(accountId)) {
    return;
  }
  await savePreferencesPatch({ connectOnboardingCompletedAccounts: [...completed, accountId] });
}

// Sign-in happens inside the Settings sheet; give its detent/session-state
// transitions a beat to settle before presenting another formSheet on top.
const PRESENT_ONBOARDING_DELAY_MS = 600;

/**
 * Consumes the onboarding request inside the navigation tree (RootStackLayout)
 * and presents the onboarding formSheet.
 */
export function useConnectOnboardingNavigation(): void {
  const navigation = useNavigation();
  const requestedAccountId = useAtomValue(connectOnboardingRequestAtom);

  useEffect(() => {
    if (requestedAccountId === null) {
      return;
    }
    const timer = setTimeout(() => {
      clearConnectOnboardingRequest();
      navigation.navigate("ConnectOnboarding");
    }, PRESENT_ONBOARDING_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [navigation, requestedAccountId]);
}

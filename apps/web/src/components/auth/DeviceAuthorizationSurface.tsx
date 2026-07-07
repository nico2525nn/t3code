import { useAuth, useClerk } from "@clerk/react";
import type { RelayDeviceAuthorizationDetails } from "@t3tools/contracts/relay";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import {
  approveDeviceAuthorization,
  completeDeviceAuthorization,
  denyDeviceAuthorization,
  formatDeviceUserCodeInput,
  getDeviceAuthorization,
  isCompleteDeviceUserCode,
} from "../../cloud/deviceAuthorization";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function DeviceSurfaceShell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-sky-500)_14%,transparent),transparent)]" />
        <div className="absolute inset-y-0 left-0 w-72 bg-[radial-gradient(28rem_18rem_at_left,color-mix(in_srgb,var(--color-violet-500)_10%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        {children}
      </section>
    </div>
  );
}

function DeviceSurfaceMessage({
  title,
  message,
  children,
}: {
  readonly title: string;
  readonly message: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <DeviceSurfaceShell>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>
      {children}
    </DeviceSurfaceShell>
  );
}

function SignInGate({
  title,
  message,
  children,
}: {
  readonly title: string;
  readonly message: string;
  readonly children: React.ReactNode;
}) {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const clerk = useClerk();

  if (!isLoaded) {
    return <DeviceSurfaceMessage title={title} message="Checking your session." />;
  }

  if (!isSignedIn) {
    return (
      <DeviceSurfaceMessage title={title} message={message}>
        <div className="mt-6">
          <Button
            size="sm"
            onClick={() => clerk.openSignIn({ forceRedirectUrl: window.location.href })}
          >
            Sign in to continue
          </Button>
        </div>
      </DeviceSurfaceMessage>
    );
  }

  return children;
}

function useClerkTokenReader(): () => Promise<string | null> {
  const { getToken } = useAuth({ treatPendingAsSignedOut: false });
  return useCallback(
    async () => (await getToken(resolveRelayClerkTokenOptions())) ?? null,
    [getToken],
  );
}

const GENERIC_FAILURE_MESSAGE =
  "The device authorization service could not be reached. Try again in a moment.";
const NOT_FOUND_MESSAGE =
  "That code was not recognized. It may have expired or already been used — run `t3 connect login --device` again to get a fresh code.";

type DeviceApprovalStep =
  | { readonly step: "enter" }
  | { readonly step: "looking-up" }
  | { readonly step: "review"; readonly details: RelayDeviceAuthorizationDetails }
  | { readonly step: "approving"; readonly details: RelayDeviceAuthorizationDetails }
  | { readonly step: "denied" }
  | { readonly step: "redirecting" };

export function DeviceAuthorizationSurface({
  initialUserCode,
}: {
  readonly initialUserCode?: string;
}) {
  if (!hasCloudPublicConfig()) {
    return (
      <DeviceSurfaceMessage
        title="Device authorization unavailable"
        message="T3 Connect is not configured for this app, so there is nothing to authorize here."
      />
    );
  }

  return (
    <SignInGate
      title="Authorize device"
      message="Sign in to your T3 Connect account to authorize the device that requested access."
    >
      <ConfiguredDeviceAuthorizationSurface
        {...(initialUserCode !== undefined ? { initialUserCode } : {})}
      />
    </SignInGate>
  );
}

function ConfiguredDeviceAuthorizationSurface({
  initialUserCode,
}: {
  readonly initialUserCode?: string;
}) {
  const readClerkToken = useClerkTokenReader();
  const [userCode, setUserCode] = useState(() => formatDeviceUserCodeInput(initialUserCode ?? ""));
  const [state, setState] = useState<DeviceApprovalStep>({ step: "enter" });
  const [errorMessage, setErrorMessage] = useState("");
  const autoLookupAttemptedRef = useRef(false);

  const lookup = useCallback(
    async (code: string) => {
      setErrorMessage("");
      setState({ step: "looking-up" });
      const clerkToken = await readClerkToken();
      if (!clerkToken) {
        setState({ step: "enter" });
        setErrorMessage("Your session expired. Sign in again to continue.");
        return;
      }
      const result = await getDeviceAuthorization(clerkToken, code);
      if (result._tag === "success") {
        if (result.value.status !== "pending") {
          setState({ step: "enter" });
          setErrorMessage(NOT_FOUND_MESSAGE);
          return;
        }
        setState({ step: "review", details: result.value });
        return;
      }
      setState({ step: "enter" });
      setErrorMessage(result._tag === "not-found" ? NOT_FOUND_MESSAGE : GENERIC_FAILURE_MESSAGE);
    },
    [readClerkToken],
  );

  useEffect(() => {
    if (autoLookupAttemptedRef.current) {
      return;
    }
    autoLookupAttemptedRef.current = true;
    const initial = formatDeviceUserCodeInput(initialUserCode ?? "");
    if (isCompleteDeviceUserCode(initial)) {
      void lookup(initial);
    }
  }, [initialUserCode, lookup]);

  const approve = useCallback(
    async (details: RelayDeviceAuthorizationDetails) => {
      setErrorMessage("");
      setState({ step: "approving", details });
      const clerkToken = await readClerkToken();
      if (!clerkToken) {
        setState({ step: "review", details });
        setErrorMessage("Your session expired. Sign in again to continue.");
        return;
      }
      const result = await approveDeviceAuthorization(clerkToken, details.userCode);
      if (result._tag === "success") {
        setState({ step: "redirecting" });
        window.location.assign(result.value.authorizationUrl);
        return;
      }
      if (result._tag === "not-found") {
        setState({ step: "enter" });
        setErrorMessage(NOT_FOUND_MESSAGE);
        return;
      }
      setState({ step: "review", details });
      setErrorMessage(GENERIC_FAILURE_MESSAGE);
    },
    [readClerkToken],
  );

  const deny = useCallback(
    async (details: RelayDeviceAuthorizationDetails) => {
      setErrorMessage("");
      const clerkToken = await readClerkToken();
      if (!clerkToken) {
        setErrorMessage("Your session expired. Sign in again to continue.");
        return;
      }
      const result = await denyDeviceAuthorization(clerkToken, details.userCode);
      if (result._tag === "success" || result._tag === "not-found") {
        setState({ step: "denied" });
        return;
      }
      setErrorMessage(GENERIC_FAILURE_MESSAGE);
    },
    [readClerkToken],
  );

  if (state.step === "denied") {
    return (
      <DeviceSurfaceMessage
        title="Request denied"
        message="The device was not authorized. You can close this window."
      />
    );
  }

  if (state.step === "redirecting") {
    return (
      <DeviceSurfaceMessage
        title="Finishing authorization"
        message="Confirming access with the sign-in service."
      />
    );
  }

  if (state.step === "review" || state.step === "approving") {
    const { details } = state;
    const approving = state.step === "approving";
    return (
      <DeviceSurfaceShell>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">Authorize device</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          A device is asking to sign in to your T3 Connect account with this code:
        </p>

        <p className="mt-4 text-center font-mono text-3xl font-semibold tracking-[0.2em]">
          {details.userCode}
        </p>

        <dl className="mt-5 space-y-2 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          <DeviceDetailRow label="Device">
            {details.deviceName ?? "Unknown device"}
            {details.devicePlatform ? ` · ${details.devicePlatform}` : ""}
            {details.clientVersion ? ` · ${details.clientVersion}` : ""}
          </DeviceDetailRow>
          {details.requestIp ? (
            <DeviceDetailRow label="Address">
              {details.requestIp}
              {details.requestLocation ? ` (${details.requestLocation})` : ""}
            </DeviceDetailRow>
          ) : null}
          <DeviceDetailRow label="Requested">
            {formatTimestamp(details.requestedAt)}
          </DeviceDetailRow>
        </dl>

        {errorMessage ? <DeviceSurfaceError message={errorMessage} /> : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button disabled={approving} size="sm" onClick={() => void approve(details)}>
            {approving ? "Authorizing..." : "Allow"}
          </Button>
          <Button
            disabled={approving}
            size="sm"
            variant="outline"
            onClick={() => void deny(details)}
          >
            Deny
          </Button>
        </div>

        <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
          Do not click Allow unless you started this login attempt yourself with{" "}
          <span className="font-mono">t3 connect login --device</span>. Anyone with this code can
          request access to your account.
        </p>
      </DeviceSurfaceShell>
    );
  }

  const lookingUp = state.step === "looking-up";
  return (
    <DeviceSurfaceShell>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">Authorize device</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Enter the code shown in your terminal to authorize the device requesting access to your T3
        Connect account.
      </p>

      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (isCompleteDeviceUserCode(userCode)) {
            void lookup(userCode);
          }
        }}
      >
        <Input
          aria-label="Device code"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          autoFocus
          className="text-center font-mono text-xl tracking-[0.25em] uppercase"
          disabled={lookingUp}
          nativeInput
          onChange={(event) => setUserCode(formatDeviceUserCodeInput(event.currentTarget.value))}
          placeholder="XXXX-XXXX"
          spellCheck={false}
          value={userCode}
        />

        {errorMessage ? <DeviceSurfaceError message={errorMessage} /> : null}

        <Button disabled={lookingUp || !isCompleteDeviceUserCode(userCode)} size="sm" type="submit">
          {lookingUp ? "Checking..." : "Continue"}
        </Button>
      </form>
    </DeviceSurfaceShell>
  );
}

function DeviceDetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 font-medium text-foreground/70">{label}</dt>
      <dd className="text-foreground/85">{children}</dd>
    </div>
  );
}

function DeviceSurfaceError({ message }: { readonly message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function DeviceAuthorizationCallbackSurface({
  code,
  state,
  authorizationError,
}: {
  readonly code?: string;
  readonly state?: string;
  readonly authorizationError?: string;
}) {
  if (!hasCloudPublicConfig()) {
    return (
      <DeviceSurfaceMessage
        title="Device authorization unavailable"
        message="T3 Connect is not configured for this app, so there is nothing to authorize here."
      />
    );
  }

  if (authorizationError) {
    return (
      <DeviceSurfaceMessage
        title="Authorization not completed"
        message="The sign-in service did not grant access to the device. You can close this window, or run `t3 connect login --device` again to retry."
      />
    );
  }

  if (!code || !state) {
    return (
      <DeviceSurfaceMessage
        title="Authorization not completed"
        message="This page is missing its authorization details. Start again from your terminal with `t3 connect login --device`."
      />
    );
  }

  return (
    <SignInGate
      title="Finish device authorization"
      message="Sign in to finish authorizing the device."
    >
      <ConfiguredDeviceAuthorizationCallbackSurface code={code} state={state} />
    </SignInGate>
  );
}

function ConfiguredDeviceAuthorizationCallbackSurface({
  code,
  state,
}: {
  readonly code: string;
  readonly state: string;
}) {
  const readClerkToken = useClerkTokenReader();
  const [status, setStatus] = useState<"completing" | "done" | "not-found" | "failed">(
    "completing",
  );
  const completionAttemptedRef = useRef(false);

  useEffect(() => {
    if (completionAttemptedRef.current) {
      return;
    }
    completionAttemptedRef.current = true;
    void (async () => {
      const clerkToken = await readClerkToken();
      if (!clerkToken) {
        setStatus("failed");
        return;
      }
      const result = await completeDeviceAuthorization(clerkToken, { state, code });
      setStatus(
        result._tag === "success" ? "done" : result._tag === "not-found" ? "not-found" : "failed",
      );
    })();
  }, [code, readClerkToken, state]);

  if (status === "completing") {
    return (
      <DeviceSurfaceMessage
        title="Finishing device authorization"
        message="Handing the authorization back to your device."
      />
    );
  }

  if (status === "done") {
    return (
      <DeviceSurfaceMessage
        title="Device authorized"
        message="You can close this window and return to your terminal — it signs in automatically within a few seconds."
      />
    );
  }

  return (
    <DeviceSurfaceMessage
      title="Authorization not completed"
      message={
        status === "not-found"
          ? NOT_FOUND_MESSAGE
          : "The device authorization could not be completed. Run `t3 connect login --device` again to retry."
      }
    />
  );
}

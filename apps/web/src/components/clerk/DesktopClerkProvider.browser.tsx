import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const internalProviderProps = vi.hoisted(() => vi.fn());

vi.mock("@clerk/clerk-js", () => ({
  Clerk: class {
    readonly publishableKey: string;

    constructor(publishableKey: string) {
      this.publishableKey = publishableKey;
    }

    addListener() {
      return () => undefined;
    }

    __internal_onBeforeRequest() {}

    __internal_onAfterResponse() {}
  },
}));

vi.mock("@clerk/react/internal", async () => {
  const React = await import("react");
  return {
    buildClerkUIScriptAttributes: () => ({}),
    clerkUIScriptUrl: () => "https://clerk.example.test/npm/@clerk/ui/dist/ui.browser.js",
    InternalClerkProvider: ({ children, ...props }: { readonly children: React.ReactNode }) => {
      internalProviderProps(props);
      return React.createElement(React.Fragment, null, children);
    },
  };
});

import { DesktopClerkProvider } from "../../cloud/desktopClerk";

const publishableKey = `pk_test_${btoa("clerk.example.test$")}`;

describe("DesktopClerkProvider", () => {
  afterEach(() => {
    document.querySelector("script[data-clerk-ui-script]")?.remove();
    Reflect.deleteProperty(window, "__internal_ClerkUICtor");
    internalProviderProps.mockClear();
  });

  it("keeps rendering children when the remote Clerk UI bundle is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await render(
      <DesktopClerkProvider publishableKey={publishableKey}>
        <main>Application content</main>
      </DesktopClerkProvider>,
    );

    await expect.element(page.getByText("Application content")).toBeVisible();

    await vi.waitFor(() => {
      expect(document.querySelector("script[data-clerk-ui-script]")).not.toBeNull();
    });
    const script = document.querySelector<HTMLScriptElement>("script[data-clerk-ui-script]");
    expect(script).not.toBeNull();
    expect(internalProviderProps).toHaveBeenCalledWith(
      expect.objectContaining({
        ui: {
          ClerkUI: expect.any(Promise),
        },
      }),
    );

    script?.dispatchEvent(new Event("error"));

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to load Clerk UI for desktop auth.",
        expect.any(Error),
      );
    });
    await expect.element(page.getByText("Application content")).toBeVisible();
  });
});

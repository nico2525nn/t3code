import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import type { ReactNode } from "react";

export const appAtomRegistry = AtomRegistry.make();

export function AppAtomRegistryProvider({ children }: { readonly children: ReactNode }) {
  return <RegistryContext.Provider value={appAtomRegistry}>{children}</RegistryContext.Provider>;
}

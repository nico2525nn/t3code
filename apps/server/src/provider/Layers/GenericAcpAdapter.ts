import {
  type CursorSettings,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { makeCursorAdapter, type CursorAdapterLiveOptions } from "./CursorAdapter.ts";

type GenericAcpAdapterSettings = Pick<CursorSettings, "enabled" | "binaryPath" | "customModels">;

type GenericAcpAdapterOptions = Omit<
  CursorAdapterLiveOptions,
  "applyCursorModelOptions" | "authMethodId" | "clientCapabilities" | "cursorExtensions"
> & {
  readonly provider: ProviderDriverKind;
  readonly instanceId: typeof ProviderInstanceId.Type;
  readonly authMethodId?: string | undefined;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
};

export function makeGenericAcpAdapter(
  settings: GenericAcpAdapterSettings,
  options: GenericAcpAdapterOptions,
) {
  return makeCursorAdapter(
    {
      ...settings,
      apiEndpoint: "",
    },
    {
      ...options,
      applyCursorModelOptions: false,
      cursorExtensions: false,
      normalizeModel: options.normalizeModel ?? ((model) => model?.trim() || "default"),
    },
  );
}

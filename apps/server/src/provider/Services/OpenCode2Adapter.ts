/**
 * OpenCode2Adapter — shape type for the OpenCode 2 provider adapter.
 *
 * Mirrors {@link ./OpenCodeAdapter | OpenCodeAdapterShape}: the driver model
 * bundles one adapter per instance as a captured closure, so this module only
 * retains the shape interface as a naming anchor.
 *
 * @module OpenCode2Adapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenCode2AdapterShape — per-instance OpenCode 2 adapter contract.
 */
export interface OpenCode2AdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

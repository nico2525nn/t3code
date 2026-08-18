import { createEffectScopeRuntime } from "./effectScopeRuntime.ts";
import { defineRuntimeContract } from "./runtimeContract.ts";

defineRuntimeContract("effect scope runtime", createEffectScopeRuntime);

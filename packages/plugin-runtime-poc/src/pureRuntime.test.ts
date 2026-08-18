import { createPureRuntime } from "./pureRuntime.ts";
import { defineRuntimeContract } from "./runtimeContract.ts";

defineRuntimeContract("pure reconciliation runtime", createPureRuntime);

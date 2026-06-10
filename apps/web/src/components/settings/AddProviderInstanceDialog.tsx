"use client";

import { CheckIcon } from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useCallback, useMemo, useReducer } from "react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import { ACPRegistryIcon, Gemini, GithubCopilotIcon, PiAgentIcon, type Icon } from "../Icons";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@t3tools/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
const WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;
interface ComingSoonDriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

const COMING_SOON_DRIVER_OPTIONS: readonly ComingSoonDriverOption[] = [
  {
    value: ProviderDriverKind.make("githubCopilot"),
    label: "Github Copilot",
    icon: GithubCopilotIcon,
  },
  {
    value: ProviderDriverKind.make("gemini"),
    label: "Gemini",
    icon: Gemini,
  },
  {
    value: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    icon: ACPRegistryIcon,
  },
  {
    value: ProviderDriverKind.make("piAgent"),
    label: "Pi Agent",
    icon: PiAgentIcon,
  },
];

/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

interface AddProviderInstanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AddProviderInstanceDraftState {
  readonly wizardStep: number;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly accentColor: string;
  readonly manualInstanceId: string;
  readonly instanceIdDirty: boolean;
  readonly configByDriver: Record<string, Record<string, unknown>>;
  readonly hasAttemptedSubmit: boolean;
}

type AddProviderInstanceDraftAction =
  | { readonly type: "setWizardStep"; readonly step: number }
  | { readonly type: "setDriver"; readonly driver: ProviderDriverKind }
  | { readonly type: "setLabel"; readonly label: string }
  | { readonly type: "setAccentColor"; readonly accentColor: string }
  | { readonly type: "setManualInstanceId"; readonly instanceId: string }
  | {
      readonly type: "setConfigDraft";
      readonly driver: ProviderDriverKind;
      readonly config: Record<string, unknown> | undefined;
    }
  | { readonly type: "markAttemptedSubmit" };

function createInitialAddProviderInstanceDraftState(): AddProviderInstanceDraftState {
  return {
    wizardStep: 0,
    driver: DEFAULT_DRIVER_KIND,
    label: "",
    accentColor: "",
    manualInstanceId: "",
    instanceIdDirty: false,
    configByDriver: {},
    hasAttemptedSubmit: false,
  };
}

function addProviderInstanceDraftReducer(
  state: AddProviderInstanceDraftState,
  action: AddProviderInstanceDraftAction,
): AddProviderInstanceDraftState {
  switch (action.type) {
    case "setWizardStep":
      return state.wizardStep === action.step ? state : { ...state, wizardStep: action.step };
    case "setDriver":
      return state.driver === action.driver ? state : { ...state, driver: action.driver };
    case "setLabel":
      return state.label === action.label ? state : { ...state, label: action.label };
    case "setAccentColor":
      return state.accentColor === action.accentColor
        ? state
        : { ...state, accentColor: action.accentColor };
    case "setManualInstanceId":
      return state.manualInstanceId === action.instanceId && state.instanceIdDirty
        ? state
        : { ...state, manualInstanceId: action.instanceId, instanceIdDirty: true };
    case "setConfigDraft": {
      const next = { ...state.configByDriver };
      if (action.config === undefined || Object.keys(action.config).length === 0) {
        delete next[action.driver];
      } else {
        next[action.driver] = action.config;
      }
      return { ...state, configByDriver: next };
    }
    case "markAttemptedSubmit":
      return state.hasAttemptedSubmit ? state : { ...state, hasAttemptedSubmit: true };
  }
}

export function AddProviderInstanceDialog({ open, onOpenChange }: AddProviderInstanceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <AddProviderInstanceDialogContent onOpenChange={onOpenChange} /> : null}
    </Dialog>
  );
}

function AddProviderInstanceDialogContent({
  onOpenChange,
}: Pick<AddProviderInstanceDialogProps, "onOpenChange">) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [draft, dispatch] = useReducer(
    addProviderInstanceDraftReducer,
    undefined,
    createInitialAddProviderInstanceDraftState,
  );
  const {
    wizardStep,
    driver,
    label,
    accentColor,
    manualInstanceId,
    instanceIdDirty,
    configByDriver,
    hasAttemptedSubmit,
  } = draft;

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const derivedInstanceId = deriveInstanceId(driver, label);
  const instanceId = instanceIdDirty ? manualInstanceId : derivedInstanceId;
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;
  const wizardStepSummaries = [driverOption.label, previewLabel, null] as const;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const setConfigDraft = useCallback(
    (config: Record<string, unknown> | undefined) => {
      dispatch({ type: "setConfigDraft", driver, config });
    },
    [driver],
  );

  const handleSave = useCallback(() => {
    dispatch({ type: "markAttemptedSubmit" });
    if (instanceIdError !== null) return;

    const config = configByDriver[driver] ?? {};
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
    };
    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateInstanceId`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
    const brandedId = ProviderInstanceId.make(instanceId);
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };
    try {
      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${driverOption.label} instance '${instanceId}' was added.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: error instanceof Error ? error.message : "Update failed.",
      });
    }
  }, [
    driver,
    driverOption,
    configByDriver,
    instanceId,
    instanceIdError,
    label,
    accentColor,
    onOpenChange,
    settings.providerInstances,
    updateSettings,
  ]);

  return (
    <DialogPopup className="max-w-xl overflow-hidden">
      <div className="flex min-h-0 flex-col overflow-hidden border-foreground/10 bg-background shadow-2xl">
        <AddProviderInstanceDialogHeader
          wizardStep={wizardStep}
          wizardStepSummaries={wizardStepSummaries}
          onStepSelect={(step) => dispatch({ type: "setWizardStep", step })}
        />
        <AddProviderInstanceDialogPanel
          wizardStep={wizardStep}
          driver={driver}
          driverOption={driverOption}
          driverSettingsFields={driverSettingsFields}
          label={label}
          onLabelChange={(nextLabel) => dispatch({ type: "setLabel", label: nextLabel })}
          instanceId={instanceId}
          instanceIdError={instanceIdError}
          showInstanceIdError={showInstanceIdError}
          onInstanceIdChange={(nextInstanceId) =>
            dispatch({ type: "setManualInstanceId", instanceId: nextInstanceId })
          }
          accentColor={accentColor}
          onAccentColorChange={(nextAccentColor) =>
            dispatch({ type: "setAccentColor", accentColor: nextAccentColor })
          }
          onDriverChange={(nextDriver) => dispatch({ type: "setDriver", driver: nextDriver })}
          configDraft={configDraft}
          onConfigDraftChange={setConfigDraft}
        />
        <AddProviderInstanceDialogFooter
          wizardStep={wizardStep}
          onBack={() => {
            if (wizardStep === 0) {
              onOpenChange(false);
              return;
            }
            dispatch({ type: "setWizardStep", step: Math.max(0, wizardStep - 1) });
          }}
          onNext={() =>
            dispatch({
              type: "setWizardStep",
              step: Math.min(WIZARD_STEPS.length - 1, wizardStep + 1),
            })
          }
          onSave={handleSave}
        />
      </div>
    </DialogPopup>
  );
}

function AddProviderInstanceDialogHeader(props: {
  wizardStep: number;
  wizardStepSummaries: readonly (string | null)[];
  onStepSelect: (step: number) => void;
}) {
  return (
    <DialogHeader className="border-b border-border/70 bg-background">
      <DialogTitle>Add provider instance</DialogTitle>
      <DialogDescription>
        Configure an additional provider instance — for example, a second Codex install pointed at a
        different workspace.
      </DialogDescription>
      <div className="grid grid-cols-3 gap-2">
        {WIZARD_STEPS.map((step, index) => (
          <button
            key={step}
            type="button"
            className={cn(
              "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left",
              index === props.wizardStep
                ? "border-primary bg-primary/10 ring-1 ring-primary/25"
                : index < props.wizardStep
                  ? "border-border bg-background"
                  : "border-border bg-muted/40",
            )}
            onClick={() => props.onStepSelect(index)}
          >
            <span
              className={cn(
                "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
                index < props.wizardStep
                  ? "border-primary bg-primary text-primary-foreground"
                  : index === props.wizardStep
                    ? "border-primary bg-background"
                    : "border-muted-foreground/35 bg-background",
              )}
              aria-hidden
            >
              {index < props.wizardStep ? <CheckIcon className="size-3" /> : null}
            </span>
            <span className="text-[10px] font-medium uppercase text-muted-foreground">
              Step {index + 1}
            </span>
            <span className="truncate text-xs font-semibold text-foreground">
              {step}
              {index < props.wizardStep && props.wizardStepSummaries[index]
                ? `: ${props.wizardStepSummaries[index]}`
                : ""}
            </span>
          </button>
        ))}
      </div>
    </DialogHeader>
  );
}

function AddProviderInstanceDialogPanel(props: {
  wizardStep: number;
  driver: ProviderDriverKind;
  driverOption: typeof DEFAULT_DRIVER_OPTION;
  driverSettingsFields: ReturnType<typeof deriveProviderSettingsFields>;
  label: string;
  onLabelChange: (label: string) => void;
  instanceId: string;
  instanceIdError: string | null;
  showInstanceIdError: boolean;
  onInstanceIdChange: (instanceId: string) => void;
  accentColor: string;
  onAccentColorChange: (accentColor: string) => void;
  onDriverChange: (driver: ProviderDriverKind) => void;
  configDraft: Record<string, unknown>;
  onConfigDraftChange: (config: Record<string, unknown> | undefined) => void;
}) {
  return (
    <div
      data-slot="dialog-panel"
      className="space-y-4 border-b border-border/70 bg-muted/20 px-6 py-5"
    >
      <AnimatedHeight>
        <AddProviderInstanceDriverStep
          active={props.wizardStep === 0}
          driver={props.driver}
          onDriverChange={props.onDriverChange}
        />
        <AddProviderInstanceIdentityStep
          active={props.wizardStep === 1}
          driver={props.driver}
          label={props.label}
          onLabelChange={props.onLabelChange}
          instanceId={props.instanceId}
          instanceIdError={props.instanceIdError}
          showInstanceIdError={props.showInstanceIdError}
          onInstanceIdChange={props.onInstanceIdChange}
          accentColor={props.accentColor}
          onAccentColorChange={props.onAccentColorChange}
        />
        <AddProviderInstanceConfigStep
          active={props.wizardStep === 2}
          driver={props.driver}
          driverOption={props.driverOption}
          driverSettingsFields={props.driverSettingsFields}
          configDraft={props.configDraft}
          onConfigDraftChange={props.onConfigDraftChange}
        />
      </AnimatedHeight>
    </div>
  );
}

function AddProviderInstanceDriverStep(props: {
  active: boolean;
  driver: ProviderDriverKind;
  onDriverChange: (driver: ProviderDriverKind) => void;
}) {
  return (
    <div className={cn("grid gap-2", !props.active && "hidden")}>
      <span id="add-instance-driver-label" className="text-xs font-medium text-foreground">
        Driver
      </span>
      <RadioGroup
        value={props.driver}
        onValueChange={(value) => props.onDriverChange(ProviderDriverKind.make(value))}
        aria-labelledby="add-instance-driver-label"
        className="grid grid-cols-2 gap-2.5"
      >
        {DRIVER_OPTIONS.map((option) => {
          const IconComponent = option.icon;
          const isSelected = option.value === props.driver;
          return (
            <RadioPrimitive.Root
              key={option.value}
              value={option.value}
              className={cn(
                "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                isSelected
                  ? "border-primary bg-background shadow-sm ring-2 ring-primary/35"
                  : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50",
              )}
            >
              <IconComponent className="size-5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {option.label}
              </span>
              {option.badgeLabel ? (
                <Badge variant="warning" size="sm">
                  {option.badgeLabel}
                </Badge>
              ) : null}
            </RadioPrimitive.Root>
          );
        })}
        {COMING_SOON_DRIVER_OPTIONS.map((option) => {
          const IconComponent = option.icon;
          return (
            <RadioPrimitive.Root
              key={option.value}
              value={option.value}
              disabled
              className={cn(
                "relative flex cursor-not-allowed items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left opacity-55 outline-none",
              )}
            >
              <IconComponent className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {option.label}
              </span>
              <Badge variant="warning" size="sm">
                Coming Soon
              </Badge>
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroup>
    </div>
  );
}

function AddProviderInstanceIdentityStep(props: {
  active: boolean;
  driver: ProviderDriverKind;
  label: string;
  onLabelChange: (label: string) => void;
  instanceId: string;
  instanceIdError: string | null;
  showInstanceIdError: boolean;
  onInstanceIdChange: (instanceId: string) => void;
  accentColor: string;
  onAccentColorChange: (accentColor: string) => void;
}) {
  return (
    <>
      <label
        htmlFor="add-provider-instance-label"
        className={cn("grid gap-2", !props.active && "hidden")}
      >
        <span className="text-xs font-medium text-foreground">Label</span>
        <Input
          id="add-provider-instance-label"
          className="bg-background"
          placeholder="e.g. Work"
          value={props.label}
          onChange={(event) => props.onLabelChange(event.target.value)}
        />
        <span className="text-[11px] text-muted-foreground">
          Shown in the provider list. Optional.
        </span>
      </label>

      <label
        htmlFor="add-provider-instance-id"
        className={cn("grid gap-2", !props.active && "hidden")}
      >
        <span className="text-xs font-medium text-foreground">Instance ID</span>
        <Input
          id="add-provider-instance-id"
          className="bg-background"
          placeholder={`${props.driver}_work`}
          value={props.instanceId}
          onChange={(event) => props.onInstanceIdChange(event.target.value)}
          aria-invalid={props.showInstanceIdError}
        />
        {props.showInstanceIdError ? (
          <span className="text-[11px] text-destructive">{props.instanceIdError}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            Routing key used by threads and sessions. Letters, digits, '-', or '_'.
          </span>
        )}
      </label>

      <div className={cn("grid gap-2", !props.active && "hidden")}>
        <span className="text-xs font-medium text-foreground">Accent color</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            type="color"
            value={normalizeProviderAccentColor(props.accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]}
            onChange={(event) => props.onAccentColorChange(event.target.value)}
            aria-label="Provider instance accent color"
            className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
          />
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
              const selected = props.accentColor.toLowerCase() === swatch;
              return (
                <button
                  key={swatch}
                  type="button"
                  className={cn(
                    "size-6 cursor-pointer rounded-full border transition",
                    selected
                      ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                      : "border-black/10 hover:scale-105 dark:border-white/20",
                  )}
                  style={{ backgroundColor: swatch }}
                  onClick={() => props.onAccentColorChange(swatch)}
                  aria-label={`Use ${swatch} accent`}
                />
              );
            })}
          </div>
          {props.accentColor ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => props.onAccentColorChange("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <span className="text-[11px] text-muted-foreground">
          Optional marker shown in the picker.
        </span>
      </div>
    </>
  );
}

function AddProviderInstanceConfigStep(props: {
  active: boolean;
  driver: ProviderDriverKind;
  driverOption: typeof DEFAULT_DRIVER_OPTION;
  driverSettingsFields: ReturnType<typeof deriveProviderSettingsFields>;
  configDraft: Record<string, unknown>;
  onConfigDraftChange: (config: Record<string, unknown> | undefined) => void;
}) {
  if (props.driverSettingsFields.length > 0) {
    return (
      <div className={cn("grid gap-4", !props.active && "hidden")}>
        <ProviderSettingsForm
          definition={props.driverOption}
          value={props.configDraft}
          idPrefix={`add-provider-${props.driver}`}
          variant="dialog"
          onChange={props.onConfigDraftChange}
        />
      </div>
    );
  }

  if (!props.active) {
    return null;
  }

  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">
        This driver has no required configuration. You can add the instance now.
      </p>
    </div>
  );
}

function AddProviderInstanceDialogFooter(props: {
  wizardStep: number;
  onBack: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  return (
    <DialogFooter className="border-t bg-background">
      <Button variant="outline" size="sm" onClick={props.onBack}>
        {props.wizardStep === 0 ? "Cancel" : "Back"}
      </Button>
      {props.wizardStep < WIZARD_STEPS.length - 1 ? (
        <Button size="sm" onClick={props.onNext}>
          Next
        </Button>
      ) : (
        <Button size="sm" onClick={props.onSave}>
          Add instance
        </Button>
      )}
    </DialogFooter>
  );
}

export interface MobileComposerExpandOptions {
  cancelPendingBlur: () => void;
  cancelPendingRelease: () => void;
  setExpandInFlight: (inFlight: boolean) => void;
  commitExpandedState: () => void;
  focusEditorAtEnd: () => void;
  scheduleRelease: () => void;
}

export function expandMobileComposerForKeyboard(options: MobileComposerExpandOptions) {
  options.cancelPendingBlur();
  options.cancelPendingRelease();
  options.setExpandInFlight(true);
  options.commitExpandedState();
  options.focusEditorAtEnd();
  options.scheduleRelease();
}

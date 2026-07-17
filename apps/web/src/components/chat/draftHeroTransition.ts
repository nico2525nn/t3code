export const DRAFT_HERO_TRANSITION_ANIMATION_ID = "t3-draft-hero-transition";
export const DRAFT_HERO_TRANSITION_DURATION_MS = 180;
export const DRAFT_HERO_TRANSITION_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export async function waitForDraftHeroTransition(): Promise<void> {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") {
    return;
  }

  const activeTransitions = document
    .getAnimations()
    .filter((animation) => animation.id === DRAFT_HERO_TRANSITION_ANIMATION_ID);

  await Promise.all(
    activeTransitions.map(async (animation) => {
      try {
        await animation.finished;
      } catch {
        // A cancelled transition is already safe to hand off.
      }
    }),
  );
}

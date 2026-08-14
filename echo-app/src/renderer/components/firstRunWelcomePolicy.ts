export const WELCOME_EXIT_MS = 800
export const WELCOME_REDUCED_EXIT_MS = 150

export function welcomeExitDelay(reducedMotion: boolean): number {
  return reducedMotion ? WELCOME_REDUCED_EXIT_MS : WELCOME_EXIT_MS
}

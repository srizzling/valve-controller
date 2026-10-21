// The valve is never meant to stay open this long without a break, whatever started it.
export const MAX_OPEN_MS = 60 * 60_000;

// A whole run, soaks included, is never meant to take longer than this from its start.
export const MAX_RUN_MS = 60 * 60_000;

/** True once a run that started at `startedAt` has been going for more than the limit. */
export const runOverdue = (startedAt: number, now: number): boolean => now - startedAt > MAX_RUN_MS;

/**
 * Tracks how long the valve has been open from once-a-minute observations.
 * `openSince` is when it was first seen open (null while closed); `overdue` is true once that is more than the limit ago.
 */
export function watchOpen(openSince: number | null, open: boolean, now: number): { openSince: number | null; overdue: boolean } {
  if (!open) return { openSince: null, overdue: false };
  const since = openSince ?? now;
  return { openSince: since, overdue: now - since > MAX_OPEN_MS };
}

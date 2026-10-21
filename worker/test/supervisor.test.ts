import { describe, expect, it } from "vitest";
import { MAX_OPEN_MS, MAX_RUN_MS, runOverdue, watchOpen } from "../src/supervisor";

const MIN = 60_000;

describe("watchOpen", () => {
  it("starts the clock when the valve is first seen open", () => {
    expect(watchOpen(null, true, 1000)).toEqual({ openSince: 1000, overdue: false });
  });

  it("is not overdue at exactly the limit, and is just after it", () => {
    expect(watchOpen(0, true, MAX_OPEN_MS).overdue).toBe(false);
    expect(watchOpen(0, true, MAX_OPEN_MS + MIN).overdue).toBe(true);
  });

  it("resets when the valve is seen closed, so a soak between waterings starts a fresh hour", () => {
    expect(watchOpen(0, false, 90 * MIN)).toEqual({ openSince: null, overdue: false });
  });

  it("keeps the original start while it stays open", () => {
    expect(watchOpen(5 * MIN, true, 20 * MIN)).toEqual({ openSince: 5 * MIN, overdue: false });
  });
});

describe("runOverdue", () => {
  it("counts the whole run from its start, soaks included", () => {
    expect(runOverdue(0, MAX_RUN_MS)).toBe(false);
    expect(runOverdue(0, MAX_RUN_MS + MIN)).toBe(true);
  });
});

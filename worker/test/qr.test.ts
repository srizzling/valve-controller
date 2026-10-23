import { describe, expect, it } from "vitest";
import { qrSvg } from "../src/qr";

describe("qrSvg", () => {
  it("draws the text as one path with no scripts or styles, which the UI's CSP allows inline", () => {
    const svg = qrSvg("tuyaSmart--qrLogin?token=abc123");
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).not.toMatch(/<script|style=|<style|on\w+=/i);
  });
});

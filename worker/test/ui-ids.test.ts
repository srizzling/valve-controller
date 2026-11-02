import { describe, expect, it } from "vitest";
import html from "../public/index.html?raw";
import app from "../public/app.js?raw";

// getElementById returns the first element with an id. The Camera card once shared "cam" with the camera in the garden scene,
// so the page un-hid the SVG group and the card never appeared, with no error anywhere.
describe("index.html ids", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

  it("has no id used twice", () => {
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("has every id that app.js looks up with $(), unless app.js makes it", () => {
    const wanted = [...new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
    expect(wanted.filter((id) => !ids.includes(id) && !app.includes(`id="${id}"`))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import variables from "../../infra/variables.tf?raw";
import workerTf from "../../infra/worker.tf?raw";

// A variable that is declared but never put in worker_vars does nothing and reports no error: `terraform validate` passes and the plan
// says "No changes". camera_scene was once left out this way, so check that every camera_* setting reaches the Worker.
describe("Terraform camera settings", () => {
  const declared = [...variables.matchAll(/^variable "(camera_[a-z_]+)"/gm)].map((m) => m[1]);

  it("declares the camera settings this test is about", () => {
    expect(declared).toEqual(expect.arrayContaining(["camera_scene", "camera_model", "camera_timelapse_hour"]));
  });

  it.each(declared)("passes %s to the Worker", (name) => {
    expect(workerTf).toMatch(new RegExp(`\\bCAMERA_[A-Z_]+\\s*=\\s*var\\.${name}\\b`));
  });
});

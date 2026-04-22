import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import betterDiffExtension, {
  BETTERDIFF_EXTENSION_STAGE,
  BETTERDIFF_NEXT_STEPS,
} from "../src/index.js";

describe("repo scaffold", () => {
  it("marks the extension as scaffold-only", () => {
    expect(BETTERDIFF_EXTENSION_STAGE).toBe("scaffold");
  });

  it("keeps the next planned steps documented in code", () => {
    expect(BETTERDIFF_NEXT_STEPS.length).toBeGreaterThan(0);
    expect(BETTERDIFF_NEXT_STEPS[0]).toContain("better-diff");
  });

  it("exports a no-op extension entrypoint", () => {
    expect(() => {
      betterDiffExtension({} as ExtensionAPI);
    }).not.toThrow();
  });
});

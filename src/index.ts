import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const BETTERDIFF_EXTENSION_STAGE = "scaffold" as const;

export const BETTERDIFF_NEXT_STEPS = [
  "Decide the better-diff UX and extension surface.",
  "Add pure diff-formatting helpers with golden tests.",
  "Add renderer and tool-integration tests before implementing runtime behavior.",
] as const;

export default function betterDiffExtension(pi: ExtensionAPI): void {
  void pi;
  // Intentionally empty.
  // This repository is scaffolded, but the actual extension behavior is not implemented yet.
}

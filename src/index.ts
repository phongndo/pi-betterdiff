import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { buildReviewModelFromTree } from "./diff/model.js";
import {
  DiffReviewComponent,
  type DiffReviewAction,
} from "./render/diff-review-ui.js";

export const BETTERDIFF_EXTENSION_STAGE = "ui-prototype" as const;

export const BETTERDIFF_NEXT_STEPS = [
  "Collect richer mutation history for write/overwrite operations.",
  "Refine split tree/detail rendering with golden tests.",
  "Add golden tests for renderer output and editor adapter targeting.",
] as const;

export default function betterDiffExtension(pi: ExtensionAPI): void {
  async function openDiffReview(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("/diff requires interactive UI mode.", "warning");
      return;
    }

    await ctx.waitForIdle();

    const model = buildReviewModelFromTree(
      ctx.sessionManager.getTree(),
      ctx.sessionManager.getLeafId(),
    );
    const result = await ctx.ui.custom<DiffReviewAction>(
      (tui, theme, keybindings, done) => {
        return new DiffReviewComponent(
          model,
          ctx.cwd,
          tui,
          theme,
          keybindings,
          done,
        );
      },
    );

    if (result.type === "undo") {
      const confirmed = await ctx.ui.confirm(
        "Undo to turn?",
        `Navigate back to before ${result.label}? The original prompt will be restored to the editor so you can edit or resubmit it.`,
      );
      if (!confirmed) return;

      const navigation = await ctx.navigateTree(result.targetEntryId, {
        summarize: false,
      });
      if (!navigation.cancelled) {
        ctx.ui.notify(`Rewound to ${result.label}.`, "info");
      }
    }
  }

  pi.registerCommand("diff", {
    description: "Review session file diffs by turn",
    handler: async (_args, ctx) => {
      await openDiffReview(ctx);
    },
  });
}

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { buildReviewModelFromTree } from "./diff/model.js";
import {
  DiffReviewComponent,
  type DiffReviewAction,
  type DiffReviewSummaryRequest,
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
    const action = await ctx.ui.custom<DiffReviewAction>(
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

    if (!action || action.type === "close") return;
    await handleDiffReviewAction(action, ctx);
  }

  async function handleDiffReviewAction(
    action: DiffReviewAction,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (action.type === "summarize") {
      await sendSummaryRequest(action.summary, action.custom, ctx);
      return;
    }

    if (action.type === "native-tree") {
      ctx.ui.setEditorText("/tree");
      ctx.ui.notify(
        `Native /tree queued for ${action.label}. Press Enter to open it.`,
        "info",
      );
    }
  }

  async function sendSummaryRequest(
    summary: DiffReviewSummaryRequest,
    custom: boolean,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    let customInstructions: string | undefined;
    if (custom) {
      customInstructions = await ctx.ui.editor(
        "Custom BetterDiff summary instructions",
        "Focus on behavior changes, risks, and follow-up tests.",
      );
      if (customInstructions === undefined) {
        ctx.ui.notify("Summary cancelled", "info");
        return;
      }
    }

    await ctx.waitForIdle();
    pi.sendUserMessage(buildSummaryPrompt(summary, customInstructions));
  }

  function buildSummaryPrompt(
    summary: DiffReviewSummaryRequest,
    customInstructions: string | undefined,
  ): string {
    return [
      "Summarize this BetterDiff selection.",
      "Focus only on the supplied session diff context. Do not modify files or run tools unless I explicitly ask later.",
      customInstructions?.trim()
        ? `\nAdditional summary instructions:\n${customInstructions.trim()}`
        : undefined,
      `\nSelection: ${summary.title}`,
      "\nDiff context:",
      "```diff",
      summary.body,
      "```",
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n");
  }

  pi.registerCommand("diff", {
    description: "Review session file diffs by turn",
    handler: async (_args, ctx) => {
      await openDiffReview(ctx);
    },
  });
}

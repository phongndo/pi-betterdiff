import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { buildReviewModel } from "../src/diff/model.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

describe("buildReviewModel", () => {
  it("groups edit diffs by turn, file, and hunk", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-04-23T00:00:00.000Z",
        message: { role: "user", content: "change alpha", timestamp: 1 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-23T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-edit",
              name: "edit",
              arguments: { path: "src/a.ts" },
            },
          ],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage,
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-04-23T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-edit",
          toolName: "edit",
          isError: false,
          content: [{ type: "text", text: "ok" }],
          details: {
            diff: "  1 keep\n- 2 old\n+ 2 new\n   ...\n 10 keep\n-11 gone\n+11 added",
            firstChangedLine: 2,
          },
          timestamp: 3,
        },
      },
    ];

    const model = buildReviewModel(entries);

    expect(model.turns).toHaveLength(1);
    expect(model.totalFiles).toBe(1);
    expect(model.totalHunks).toBe(2);
    expect(model.additions).toBe(2);
    expect(model.removals).toBe(2);
    expect(model.turns[0]?.files[0]?.path).toBe("src/a.ts");
    expect(
      model.turns[0]?.files[0]?.hunks.map((hunk) => hunk.jumpLine),
    ).toEqual([2, 11]);
  });

  it("creates a synthetic write hunk from tool call content", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-04-23T00:00:00.000Z",
        message: { role: "user", content: "write a file", timestamp: 1 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-23T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-write",
              name: "write",
              arguments: { path: "README.md", content: "# Title\nBody\n" },
            },
          ],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage,
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-04-23T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-write",
          toolName: "write",
          isError: false,
          content: [{ type: "text", text: "ok" }],
          timestamp: 3,
        },
      },
    ];

    const model = buildReviewModel(entries);
    const hunk = model.turns[0]?.files[0]?.hunks[0];

    expect(hunk?.toolName).toBe("write");
    expect(hunk?.jumpLine).toBe(1);
    expect(hunk?.additions).toBe(2);
    expect(hunk?.bodyLines).toEqual(["+1 # Title", "+2 Body"]);
  });
});

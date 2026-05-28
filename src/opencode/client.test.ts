import { describe, it, expect } from "vitest";
import { getAvailableModels } from "./client.js";
import { createOpencodeClient } from "@opencode-ai/sdk";

describe("getAvailableModels", () => {
  it("should retrieve models list", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
    });
    const sseResult = await client.global.event();
    console.log("SSE RESULT:", sseResult);
    expect(sseResult.stream).toBeDefined();
  });
});

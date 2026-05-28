import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { isServerRunning } from "./server.js";
import { REVIEW_AGENT_PROMPT, buildReviewPrompt } from "./agent.js";
import type { CommitDogConfig } from "../config.js";

export interface ReviewOptions {
  mode: "last-commit" | "staged";
  config: CommitDogConfig;
  onChunk?: (text: string) => void;
  onComplete?: (fullText: string) => void;
}

/**
 * Run a code review using OpenCode serve.
 * Creates a session, sends the review prompt, and streams the response.
 */
export async function runReview(options: ReviewOptions): Promise<string> {
  const { mode, config, onChunk } = options;
  const port = config.server.port;

  let client;
  let cleanup: (() => void) | undefined;

  // Try to connect to existing server, otherwise start one via SDK
  if (await isServerRunning(port)) {
    client = createOpencodeClient({
      baseURL: `http://127.0.0.1:${port}`,
    });
  } else {
    const oc = await createOpencode({ port });
    client = oc.client;
    cleanup = oc.server.close;
  }

  try {
    // Create a new session for this review
    const session = await client.session.create({
      body: {},
    });
    const sessionId = (session.data as any).id;

    // Build the review prompt
    const prompt = buildReviewPrompt(mode, config.rules);

    // Parse the model string (e.g. "anthropic/claude-sonnet-4-20250514")
    const [providerID, modelID] = config.model.includes("/")
      ? config.model.split("/", 2)
      : ["anthropic", config.model];

    // Set up SSE event listener to stream output
    let fullResponse = "";
    const responsePromise = new Promise<string>((resolve, reject) => {
      const eventSource = new EventSource(
        `http://127.0.0.1:${port}/global/event`
      );

      let settled = false;

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Look for message part updates from our session
          if (
            data.type === "message.part.updated" &&
            data.properties?.sessionID === sessionId
          ) {
            const text = data.properties?.part?.text;
            if (text && typeof text === "string") {
              const delta = text.slice(fullResponse.length);
              if (delta) {
                fullResponse = text;
                onChunk?.(delta);
              }
            }
          }

          // Session complete
          if (
            data.type === "session.updated" &&
            data.properties?.session?.id === sessionId &&
            data.properties?.session?.busy === false &&
            fullResponse.length > 0
          ) {
            if (!settled) {
              settled = true;
              eventSource.close();
              resolve(fullResponse);
            }
          }

          // Also check for message completion
          if (
            data.type === "message.updated" &&
            data.properties?.sessionID === sessionId
          ) {
            const msg = data.properties?.message;
            if (
              msg?.role === "assistant" &&
              msg?.metadata?.status === "completed" &&
              fullResponse.length > 0
            ) {
              if (!settled) {
                settled = true;
                eventSource.close();
                resolve(fullResponse);
              }
            }
            if (msg?.metadata?.status === "error") {
              if (!settled) {
                settled = true;
                eventSource.close();
                reject(
                  new Error(msg?.metadata?.error || "Review failed")
                );
              }
            }
          }
        } catch {
          // Ignore parse errors on individual events
        }
      };

      eventSource.onerror = () => {
        if (!settled && !fullResponse) {
          settled = true;
          eventSource.close();
          reject(new Error("Lost connection to OpenCode server"));
        }
      };

      // Safety timeout: 5 minutes
      setTimeout(() => {
        if (!settled) {
          settled = true;
          eventSource.close();
          resolve(fullResponse || "Review timed out.");
        }
      }, 5 * 60 * 1000);
    });

    // Send the review prompt
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        system: REVIEW_AGENT_PROMPT,
        model: { providerID, modelID },
        parts: [{ type: "text", text: prompt }],
      },
    });

    const result = await responsePromise;
    options.onComplete?.(result);
    return result;
  } finally {
    // Don't cleanup the server — leave it running for future reviews
    // cleanup?.();
  }
}

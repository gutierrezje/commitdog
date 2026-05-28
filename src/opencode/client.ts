import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { isServerRunning, ensureServer } from "./server.js";
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

  // Try to connect to existing server, otherwise start one via SDK
  if (await isServerRunning(port)) {
    client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
    });
  } else {
    const oc = await createOpencode({ port });
    client = oc.client;
  }

  // Create a new session for this review
  const session = await client.session.create({
    body: {},
  });
  const sessionId = (session.data as any).id;

  // Build the review prompt
  const prompt = buildReviewPrompt(mode, config.rules, config.include, config.exclude);

  // Parse the model string (e.g. "anthropic/claude-sonnet-4-20250514")
  const parts = config.model.split("/");
  const providerID = parts[0];
  const modelID = parts.slice(1).join("/");

  // Set up SSE event listener to stream output
  let fullResponse = "";
  const sseResult = await client.global.event();
  const responsePromise = new Promise<string>((resolve, reject) => {
    let settled = false;

    // Safety timeout: 5 minutes
    const safetyTimeout = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          resolve(fullResponse || "Review timed out.");
        }
      },
      5 * 60 * 1000,
    );

    (async () => {
      try {
        for await (const event of sseResult.stream) {
          if (settled) break;

          const payload = (event as any).payload;
          if (!payload) continue;

          // Look for message part updates from our session
          if (
            payload.type === "message.part.updated" &&
            payload.properties?.part?.sessionID === sessionId
          ) {
            const text = payload.properties?.part?.text;
            if (text && typeof text === "string") {
              // Ignore user prompt parts
              if (text.startsWith(prompt.substring(0, 30))) {
                continue;
              }
              const delta = text.slice(fullResponse.length);
              if (delta) {
                fullResponse = text;
                onChunk?.(delta);
              }
            }
          }

          // Also check for message error
          if (
            payload.type === "message.updated" &&
            payload.properties?.info?.sessionID === sessionId
          ) {
            const msg = payload.properties?.info;
            if (msg?.role === "assistant" && msg.error) {
              if (!settled) {
                settled = true;
                clearTimeout(safetyTimeout);
                reject(new Error(msg.error.data?.message || "Review failed"));
                break;
              }
            }
          }

          // Check for session going completely idle
          if (
            payload.type === "session.idle" &&
            payload.properties?.sessionID === sessionId &&
            fullResponse.length > 0
          ) {
            if (!settled) {
              settled = true;
              clearTimeout(safetyTimeout);
              resolve(fullResponse);
              break;
            }
          }
        }
      } catch (streamErr) {
        if (!settled) {
          settled = true;
          clearTimeout(safetyTimeout);
          reject(streamErr);
        }
      }
    })();
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
}

/**
 * Get all available models from the OpenCode server
 */
export async function getAvailableModels(port: number): Promise<string[]> {
  if (!(await isServerRunning(port))) {
    try {
      await ensureServer(port);
    } catch {
      return [];
    }
  }

  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
  });

  try {
    const res = await client.provider.list();
    const payload = (res as any).data;

    if (!payload || !payload.all) {
      return [];
    }

    const connected = payload.connected || [];
    const modelsList: string[] = [];

    for (const provider of payload.all) {
      // Only include connected providers
      if (!connected.includes(provider.id)) {
        continue;
      }

      if (provider.models) {
        for (const modelKey of Object.keys(provider.models)) {
          const model = provider.models[modelKey];
          // Only show active models
          if (model.status === "active" || !model.status) {
            modelsList.push(`${provider.id}/${model.id}`);
          }
        }
      }
    }

    return modelsList.sort();
  } catch {
    return [];
  }
}

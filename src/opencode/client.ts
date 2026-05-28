import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { isServerRunning, ensureServer } from "./server.js";
import { REVIEW_AGENT_PROMPT, buildReviewPrompt } from "./agent.js";
import type { CommitDogConfig } from "../config.js";

export type ReviewSeverity = "error" | "warning" | "info";

export type ReviewConfidence = "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string;
  line: number;
  title: string;
  body: string;
  confidence: ReviewConfidence;
}

export interface ReviewReport {
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewOptions {
  mode: "last-commit" | "staged";
  config: CommitDogConfig;
}

/**
 * Run a code review using OpenCode serve.
 * Creates a session, sends the review prompt, and returns a structured report.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewReport> {
  const { mode, config } = options;
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

  // Set up SSE event listener to capture the final structured response
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
              // We intentionally do NOT stream partial chunks to stdout.
              // Instead we accumulate the full response and then parse the JSON payload.
              if (text.length > fullResponse.length) {
                fullResponse = text;
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

  const raw = await responsePromise;
  return parseStructuredReview(raw);
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

function parseStructuredReview(raw: string): ReviewReport {
  // Expect a line starting with FINAL_REVIEW_JSON followed by a single JSON object.
  const marker = "FINAL_REVIEW_JSON";
  const markerIndex = raw.indexOf(marker);

  if (markerIndex === -1) {
    throw new Error("Review did not include FINAL_REVIEW_JSON marker.");
  }

  const afterMarker = raw.slice(markerIndex + marker.length);
  const firstBrace = afterMarker.indexOf("{");
  const lastBrace = afterMarker.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Review did not include a valid JSON object after FINAL_REVIEW_JSON.");
  }

  const jsonText = afterMarker.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse review JSON: ${(err as Error).message}`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as any).summary !== "string" ||
    !Array.isArray((parsed as any).findings)
  ) {
    throw new Error("Review JSON is missing required fields: summary or findings.");
  }

  const summary = (parsed as any).summary as string;
  const findingsInput = (parsed as any).findings as any[];

  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();

  for (const item of findingsInput) {
    if (!item || typeof item !== "object") continue;

    const severityRaw = String(item.severity ?? "").toLowerCase();
    const file = typeof item.file === "string" ? item.file : "";
    const line = Number.isFinite(item.line) ? Number(item.line) : NaN;
    const title = typeof item.title === "string" ? item.title : "";
    const body = typeof item.body === "string" ? item.body : "";
    const confidenceRaw = String(item.confidence ?? "").toLowerCase();

    if (!file || !Number.isFinite(line) || line <= 0 || !title || !body) {
      continue;
    }

    if (severityRaw !== "error" && severityRaw !== "warning" && severityRaw !== "info") {
      continue;
    }

    const confidence: ReviewConfidence =
      confidenceRaw === "low" || confidenceRaw === "medium" || confidenceRaw === "high"
        ? (confidenceRaw as ReviewConfidence)
        : "high";

    const key = `${severityRaw}:${file}:${line}:${title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    findings.push({
      severity: severityRaw as ReviewSeverity,
      file,
      line,
      title,
      body,
      confidence,
    });
  }

  return {
    summary,
    findings,
  };
}

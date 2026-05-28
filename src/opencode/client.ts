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
  timings?: ReviewTiming[];
}

export interface ReviewOptions {
  mode: "last-commit" | "staged";
  config: CommitDogConfig;
  localContext?: string;
  onProgress?: (event: ReviewProgressEvent) => void;
}

export type ReviewProgressEvent =
  | { type: "server"; message: string }
  | { type: "session"; message: string; sessionId?: string }
  | { type: "tool"; message: string; tool: string; status: string }
  | { type: "output"; message: string; characters: number }
  | { type: "timing"; message: string; phase: string; ms: number }
  | { type: "idle"; message: string };

export interface ReviewTiming {
  phase: string;
  label: string;
  ms: number;
}

/**
 * Run a code review using OpenCode serve.
 * Creates a session, sends the review prompt, and returns a structured report.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewReport> {
  const { mode, config, localContext, onProgress } = options;
  const port = config.server.port;
  const timings: ReviewTiming[] = [];

  let client;

  // Try to connect to existing server, otherwise start one via SDK
  const connectStart = performance.now();
  if (await isServerRunning(port)) {
    onProgress?.({ type: "server", message: `Connected to OpenCode on port ${port}.` });
    client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
    });
  } else {
    onProgress?.({ type: "server", message: `Starting OpenCode on port ${port}.` });
    const oc = await createOpencode({ port });
    client = oc.client;
  }
  recordTiming(timings, onProgress, "opencode-connect", "OpenCode client connection", connectStart);

  // Create a new session for this review
  const sessionStart = performance.now();
  const session = await client.session.create({
    body: {},
  });
  const sessionId = (session.data as any).id;
  recordTiming(timings, onProgress, "session-create", "OpenCode session creation", sessionStart);
  onProgress?.({ type: "session", message: "Created review session.", sessionId });

  // Build the review prompt
  const promptStart = performance.now();
  const prompt = buildReviewPrompt(
    mode,
    config.rules,
    config.include,
    config.exclude,
    localContext,
  );
  recordTiming(timings, onProgress, "prompt-build", "Review prompt build", promptStart);

  // Parse the model string (e.g. "anthropic/claude-sonnet-4-20250514")
  const parts = config.model.split("/");
  const providerID = parts[0];
  const modelID = parts.slice(1).join("/");

  // Set up SSE event listener to capture the final structured response
  let fullResponse = "";
  const eventsController = new AbortController();
  const eventStart = performance.now();
  const sseResult = await client.global.event({
    signal: eventsController.signal,
  });
  recordTiming(timings, onProgress, "event-stream", "OpenCode event stream connection", eventStart);
  const responsePromise = new Promise<string>((resolve, reject) => {
    let settled = false;
    let safetyTimeout: ReturnType<typeof setTimeout>;

    const settle = (outcome: "resolve" | "reject", value: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimeout);
      eventsController.abort();

      if (outcome === "resolve") {
        resolve(value as string);
      } else {
        reject(value);
      }
    };

    // Safety timeout: 5 minutes
    safetyTimeout = setTimeout(
      () => {
        settle("reject", new Error("Review timed out."));
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
            const part = payload.properties.part;

            if (part.type === "tool") {
              const state = part.state?.status ?? "unknown";
              const title =
                part.state && "title" in part.state && typeof part.state.title === "string"
                  ? part.state.title
                  : part.tool;
              onProgress?.({
                type: "tool",
                message: `${title} (${state})`,
                tool: part.tool,
                status: state,
              });
            }

            if (part.type === "text" && part.text && typeof part.text === "string") {
              // We intentionally do NOT stream partial chunks to stdout.
              // Instead we accumulate the full response and then parse the JSON payload.
              if (part.text.length > fullResponse.length) {
                fullResponse = part.text;
                onProgress?.({
                  type: "output",
                  message: `Review response received (${fullResponse.length} chars).`,
                  characters: fullResponse.length,
                });
              }

              // Some OpenCode sessions never emit `session.idle` (or it can be missed).
              // If we already have a complete JSON payload, finish immediately.
              if (looksLikeCompleteStructuredReview(fullResponse)) {
                settle("resolve", fullResponse);
                break;
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
              settle("reject", new Error(msg.error.data?.message || "Review failed"));
              break;
            }
          }

          if (payload.type === "session.status" && payload.properties?.sessionID === sessionId) {
            const status = payload.properties.status;
            const message =
              status.type === "retry"
                ? `OpenCode retrying: ${status.message}`
                : `OpenCode session ${status.type}.`;
            onProgress?.({ type: "session", message, sessionId });
          }

          // Check for session going completely idle
          if (
            payload.type === "session.idle" &&
            payload.properties?.sessionID === sessionId &&
            fullResponse.length > 0
          ) {
            onProgress?.({ type: "idle", message: "OpenCode session is idle." });
            settle("resolve", fullResponse);
            break;
          }
        }

        // If the stream ends without throwing and without emitting `session.idle`,
        // we must still settle. Otherwise the caller can hang indefinitely.
        if (!settled) {
          if (fullResponse.length > 0) {
            settle("resolve", fullResponse);
          } else {
            settle(
              "reject",
              new Error("OpenCode event stream ended before any review text was received."),
            );
          }
        }
      } catch (streamErr) {
        if (!settled && !eventsController.signal.aborted) {
          settle("reject", streamErr instanceof Error ? streamErr : new Error(String(streamErr)));
        }
      }
    })();
  });

  // Send the review prompt
  onProgress?.({ type: "session", message: "Sending review prompt.", sessionId });
  const promptSendStart = performance.now();
  await client.session.prompt({
    path: { id: sessionId },
    body: {
      system: REVIEW_AGENT_PROMPT,
      model: { providerID, modelID },
      parts: [{ type: "text", text: prompt }],
    },
  });
  recordTiming(timings, onProgress, "prompt-send", "Review prompt send", promptSendStart);

  const agentWaitStart = performance.now();
  const raw = await responsePromise;
  recordTiming(timings, onProgress, "agent-wait", "OpenCode review generation", agentWaitStart);

  const parseStart = performance.now();
  const report = parseStructuredReview(raw);
  recordTiming(timings, onProgress, "parse-review", "Review JSON parsing", parseStart);

  return { ...report, timings };
}

function recordTiming(
  timings: ReviewTiming[],
  onProgress: ReviewOptions["onProgress"],
  phase: string,
  label: string,
  start: number,
): void {
  const ms = performance.now() - start;
  timings.push({ phase, label, ms });
  onProgress?.({ type: "timing", message: `${label}: ${formatDuration(ms)}`, phase, ms });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
    throw new Error(`Failed to parse review JSON: ${(err as Error).message}`);
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

function looksLikeCompleteStructuredReview(text: string): boolean {
  const marker = "FINAL_REVIEW_JSON";
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return false;

  const afterMarker = text.slice(markerIndex + marker.length);
  const firstBrace = afterMarker.indexOf("{");
  const lastBrace = afterMarker.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return false;

  const jsonText = afterMarker.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(jsonText);
    return (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as any).summary === "string" &&
      Array.isArray((parsed as any).findings)
    );
  } catch {
    return false;
  }
}

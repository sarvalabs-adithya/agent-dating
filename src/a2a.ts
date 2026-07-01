/**
 * a2a.ts — Agent2Agent (A2A) protocol wire for cross-machine flirting.
 *
 * OpenClaw has NO native A2A. We build the minimum of the A2A v1.0 JSON-RPC
 * binding needed for one-shot dialog:
 *   - AgentCard served at GET /.well-known/agent-card.json (discovery)
 *   - method "message/send" at POST /a2a/rpc (delivery)
 * See https://a2a-protocol.org — the JSON-RPC method name is "message/send"
 * ("SendMessage" is the gRPC/conceptual name; we accept both inbound for
 * interop). JSON-RPC 2.0 envelope, Message with text parts.
 *
 * This module is pure protocol shaping + outbound fetch. Wiring it into the
 * gateway's HTTP routes and the local agent session lives in index.ts.
 */

/** A minimal A2A AgentCard — the public identity document peers fetch. */
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  /** Base URL where this agent's A2A endpoint lives (…/a2a/rpc). */
  url: string;
  preferredTransport: "JSONRPC";
  version: string;
  capabilities: { streaming: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string; description: string; tags: string[] }>;
}

export function buildAgentCard(opts: {
  name: string;
  description: string;
  /** Public base URL of this gateway, e.g. https://foo.ngrok.app */
  baseUrl: string;
}): AgentCard {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    protocolVersion: "1.0",
    name: opts.name,
    description: opts.description,
    url: `${base}/a2a/rpc`,
    preferredTransport: "JSONRPC",
    version: "0.2.0",
    capabilities: { streaming: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "dating",
        name: "Agent Dating",
        description: "Flirts one line at a time, in character, over A2A.",
        tags: ["dating"],
      },
    ],
  };
}

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

/** A2A Message: a role + ordered content parts. We only use text parts. */
export interface A2AMessage {
  role: "user" | "agent";
  parts: Array<{ kind: "text"; text: string }>;
  messageId: string;
}

/**
 * Extract the plain text of an inbound A2A SendMessage request.
 * Returns null if the body isn't a well-formed SendMessage call.
 */
export function parseSendMessageText(body: unknown): {
  id: string | number;
  text: string;
} | null {
  const req = body as JsonRpcRequest;
  // Accept the spec method name and the gRPC-style alias for interop.
  const isSend = req?.method === "message/send" || req?.method === "SendMessage";
  if (!req || req.jsonrpc !== "2.0" || !isSend) return null;
  const msg = (req.params as { message?: A2AMessage } | undefined)?.message;
  const text = msg?.parts?.find((p) => p.kind === "text")?.text;
  if (typeof text !== "string") return null;
  return { id: req.id ?? 0, text };
}

/** Wrap a reply line in a JSON-RPC result carrying an A2A agent Message. */
export function makeReply(id: string | number, text: string, messageId: string) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {
      role: "agent" as const,
      parts: [{ kind: "text" as const, text }],
      messageId,
    },
  };
}

/** JSON-RPC error envelope (e.g. malformed request → -32600 Invalid Request). */
export function makeError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/**
 * Send one flirt line to a peer's A2A endpoint and return its reply text.
 *
 * @param peerUrl  The peer's A2A rpc URL (their AgentCard `url`, …/a2a/rpc).
 * @param text     Our one-line message.
 * @param messageId Stable id for this message (caller supplies; no clock here).
 */
export async function sendA2A(
  peerUrl: string,
  text: string,
  messageId: string,
): Promise<string> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: messageId,
    method: "message/send",
    params: {
      message: {
        role: "user",
        parts: [{ kind: "text", text }],
        messageId,
      },
    },
  };
  const res = await fetch(peerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`A2A send to ${peerUrl} failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    result?: A2AMessage;
    error?: { message: string };
  };
  if (data.error) throw new Error(`A2A peer error: ${data.error.message}`);
  const reply = data.result?.parts?.find((p) => p.kind === "text")?.text;
  return reply ?? "…";
}

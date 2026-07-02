/**
 * a2a.ts — agent-to-agent message wire.
 *
 * Matches the MOI agent convention (webinar say-hi.mjs): messaging is a plain
 *   POST <profile.url>/message   with body { from, text }
 * and the reply comes back in the HTTP response body (JSON or text). This is
 * NOT the A2A JSON-RPC spec — it's the simpler shape the agents actually on the
 * MOI registry speak, so we speak it too.
 *
 * Pure protocol shaping + outbound fetch. Route wiring lives in index.ts.
 */

/** The path each agent serves its inbox at, appended to its registered url. */
export const MESSAGE_PATH = "/message";

/** Inbound/outbound message body. */
export interface AgentMessage {
  from: string;
  text: string;
}

/** Parse an inbound POST /message body. Returns null if malformed. */
export function parseInboundMessage(body: unknown): AgentMessage | null {
  const m = body as Partial<AgentMessage> | undefined;
  if (!m || typeof m.text !== "string") return null;
  return { from: typeof m.from === "string" ? m.from : "unknown", text: m.text };
}

/** Build the reply body this agent returns from its /message route. */
export function makeReply(from: string, text: string): AgentMessage {
  return { from, text };
}

/**
 * Send one line to a peer and return its reply text.
 *
 * @param peerBaseUrl  The peer's registered url (profile.url); we POST to
 *                     `${peerBaseUrl}/message`.
 * @param from         Our own agent/wallet identifier.
 * @param text         The line to send.
 */
export async function sendMessage(
  peerBaseUrl: string,
  from: string,
  text: string,
): Promise<string> {
  const endpoint = `${peerBaseUrl.replace(/\/+$/, "")}${MESSAGE_PATH}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, text }),
  });
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`message POST to ${endpoint} returned HTTP ${res.status}: ${raw || "<no body>"}`);
  }
  // Reply may be JSON ({text}/{reply}/{message}) or plain text.
  try {
    const j = JSON.parse(raw);
    return j.text ?? j.reply ?? j.message ?? (typeof j === "string" ? j : raw) ?? "…";
  } catch {
    return raw || "…";
  }
}

/**
 * The MOI agent card (self-hosted at /moi/card.json, referenced by card_uri).
 * `url` is the agent's base — peers append `${url}/message`.
 */
export interface AgentCard {
  name: string;
  description: string;
  url: string;
  skills: Array<{ id: string; name: string; description: string; tags: string[] }>;
}

export function buildAgentCard(opts: {
  name: string;
  description: string;
  /** Public base URL of this gateway, e.g. https://foo.ngrok.app */
  baseUrl: string;
}): AgentCard {
  return {
    name: opts.name,
    description: opts.description,
    url: opts.baseUrl.replace(/\/+$/, ""),
    skills: [
      {
        id: "dating",
        name: "Agent Dating",
        description: "Flirts one line at a time, in character.",
        tags: ["dating"],
      },
    ],
  };
}

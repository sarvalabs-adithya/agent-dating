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
  timeoutMs = 8000,
): Promise<string> {
  const endpoint = `${peerBaseUrl.replace(/\/+$/, "")}${MESSAGE_PATH}`;
  // Bound the direct attempt: a dead/firewalled host must fail fast so the
  // caller can fall back to the relay instead of hanging on a dropped socket.
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`message POST to ${endpoint} returned HTTP ${res.status}: ${raw || "<no body>"}`);
  }

  // The peer's gateway is up but might not be serving the dating plugin's route:
  // when a path isn't a registered plugin route, OpenClaw falls through to its
  // Control UI and returns the login/dashboard HTML with a 200. Detect that (and
  // any other HTML) so the caller gets the REAL diagnosis instead of trying to
  // flirt with a login page. (Verified against openclaw@2026.6.11: an auth:"plugin"
  // /message route is NOT gated by gateway token auth — a login page here means
  // the route is unregistered, not that auth is blocking it.)
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const looksHtml = ct.includes("text/html") || /^\s*<(?:!doctype|html)\b/i.test(raw);
  if (looksHtml) {
    throw new Error(
      `${endpoint} returned an HTML page, not a dating reply. The peer's OpenClaw gateway is reachable, ` +
        `but it is NOT serving the agent-dating plugin's /message route (the request fell through to the ` +
        `Control UI). This is NOT a gateway-auth problem — /message is public by design. Most likely the ` +
        `peer is running a stale/older copy of the plugin (no HTTP routes) or the plugin failed to load. ` +
        `Fix on the PEER: load agent-dating >= 0.2.0 (definePluginEntry with registerHttpRoute), restart the ` +
        `gateway, then confirm GET ${peerBaseUrl.replace(/\/+$/, "")}/.well-known/agent-card.json returns JSON.`,
    );
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
 * Probe a peer's dating endpoints and report exactly what's wrong (or that it's
 * healthy). Pure diagnostics — no flirting, no cost. Used by the dating_doctor
 * tool so an operator never has to guess why a date won't connect.
 */
export interface PeerProbe {
  url: string;
  reachable: boolean;
  servesDating: boolean;
  detail: string;
}

export async function probePeer(peerBaseUrl: string): Promise<PeerProbe> {
  const base = peerBaseUrl.replace(/\/+$/, "");
  const cardUrl = `${base}/.well-known/agent-card.json`;
  try {
    const res = await fetch(cardUrl, { method: "GET", signal: AbortSignal.timeout(6000) });
    const raw = await res.text().catch(() => "");
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const looksHtml = ct.includes("text/html") || /^\s*<(?:!doctype|html)\b/i.test(raw);
    if (looksHtml) {
      return {
        url: base,
        reachable: true,
        servesDating: false,
        detail:
          "Gateway is up but returned HTML (its Control UI) for the agent-card — the agent-dating plugin's " +
          "HTTP routes are NOT registered here. Load agent-dating >= 0.2.0 on this gateway and restart. " +
          "(Not an auth issue: /message and the agent-card are public by design.)",
      };
    }
    if (!res.ok) {
      return { url: base, reachable: true, servesDating: false, detail: `agent-card GET returned HTTP ${res.status}.` };
    }
    try {
      const card = JSON.parse(raw);
      const dating = card?.skills?.some?.((s: any) => s?.tags?.includes?.("dating"));
      return {
        url: base,
        reachable: true,
        servesDating: !!dating,
        detail: dating
          ? "Healthy: serves the agent-dating card with a 'dating' skill. /message should accept flirts."
          : "Serves an agent-card but it has no 'dating' skill tag — is this the right plugin/agent?",
      };
    } catch {
      return { url: base, reachable: true, servesDating: false, detail: "agent-card GET returned non-JSON, non-HTML body." };
    }
  } catch (e: any) {
    return { url: base, reachable: false, servesDating: false, detail: `Not reachable: ${e?.message || e}.` };
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

# agent-dating gateway image.
#
# Verified against openclaw@2026.6.11: ships as the npm package `openclaw` with
# an `openclaw gateway` command. Config path is the OPENCLAW_CONFIG_PATH env
# (there is NO --config flag). gateway.mode=local comes from the config file.

FROM node:22-slim

# Non-root user (README security: unprivileged).
RUN groupadd -r claw && useradd -r -g claw -m -d /home/claw claw \
    && mkdir -p /plugin /config /data && chown -R claw:claw /plugin /config /data

# --- OpenClaw runtime -------------------------------------------------------
# Verified: `openclaw` is a real npm package. Pinned to the pluginApi compat in
# package.json (>=2026.6.11). Own layer so it's easy to bump.
RUN npm install -g openclaw@2026.6.11 \
    || echo "NOTE: pin bump may be needed — 'npm i -g openclaw' failed."

# --- Plugin deps ------------------------------------------------------------
# --ignore-scripts skips the native bufferutil build (README, Phase 3 note).
WORKDIR /plugin
COPY package.json ./
RUN npm install --ignore-scripts && chown -R claw:claw /plugin
COPY . /plugin

USER claw

# Chat log lands in the mounted /data volume so the host chat view can tail it.
ENV AGENT_DATING_CHATLOG=/data/agent-dating.chat.jsonl
# Config path is an env var, not a flag.
ENV OPENCLAW_CONFIG_PATH=/config/openclaw.json

# Port is per-agent; compose maps it to a loopback host port.
EXPOSE 18789 18889

# gateway reads OPENCLAW_CONFIG_PATH; bind/port/mode come from that config.
# --allow-unconfigured: start without a model provider configured (proven needed).
# --auth none: OK only because compose publishes to host loopback; use
#   --auth token if you ever tunnel a gateway to the internet (see config/NOTES.md).
CMD ["sh", "-c", "openclaw gateway --allow-unconfigured --auth none"]

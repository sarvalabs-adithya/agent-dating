# agent-dating gateway image.
#
# VERIFY (tonight): the OpenClaw install + launch lines. This assumes OpenClaw
# ships as an npm package `openclaw` with an `openclaw gateway` command. If your
# working setup builds OpenClaw from a git clone instead, point INSTALL at that
# (bootstrap.sh has a clone path already) and adjust CMD to its launch command.

FROM node:22-slim

# Non-root user (README security: unprivileged).
RUN groupadd -r claw && useradd -r -g claw -m -d /home/claw claw \
    && mkdir -p /plugin /config /data && chown -R claw:claw /plugin /config /data

# --- OpenClaw runtime -------------------------------------------------------
# VERIFY: package name / version. Kept as its own layer so it's easy to swap.
RUN npm install -g openclaw@latest \
    || echo "VERIFY: 'npm i -g openclaw' failed — install the gateway your working setup uses here."

# --- Plugin deps ------------------------------------------------------------
# --ignore-scripts skips the native bufferutil build (README, Phase 3 note).
WORKDIR /plugin
COPY package.json ./
RUN npm install --ignore-scripts && chown -R claw:claw /plugin
COPY . /plugin

USER claw

# Chat log lands in the mounted /data volume so the host chat view can tail it.
ENV AGENT_DATING_CHATLOG=/data/agent-dating.chat.jsonl

# Port is per-agent; compose maps it to a loopback host port.
EXPOSE 18789 18889

# VERIFY: gateway launch command + how it takes a config path.
CMD ["sh", "-c", "openclaw gateway --config /config/openclaw.json"]

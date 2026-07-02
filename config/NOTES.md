# Config template notes

(Kept here because openclaw.json's schema is STRICT — unknown root keys like
`__note` make the gateway refuse to start with `<root>: Invalid input`. Proven
by running `openclaw config validate` against 2026.6.11.)

- Rendered by `scripts/render-config.mjs` into `runtime/agent-{a,b}/openclaw.json`
  (values are JSON-escaped from `.env`).
- `gateway.bind: "custom"` + `customBindHost: "0.0.0.0"` is required **in Docker**:
  the port publish maps to the container's eth0, so binding container-loopback
  would make the gateway unreachable. External exposure stays loopback-only
  because docker-compose publishes to `127.0.0.1:PORT` on the host.
  For a bare-host run, switch to `"bind": "loopback"`.
- `plugins.load.paths: ["/plugin"]` — local plugin dirs load here (verified:
  raw `.ts` plugin loads, no build step needed). `plugins.entries.<id>.config`
  holds the plugin's own config; there is NO `path` key inside `entries`.
- `tools.alsoAllow` merges the dating tools into the active tool profile.
- The gateway is started with `--allow-unconfigured --auth none` (see
  docker/Dockerfile). Auth `none` is acceptable ONLY because ports publish to
  host loopback. If you expose a gateway through a tunnel for a cross-machine
  demo, switch to `--auth token` (or gateway.auth config) — otherwise the
  control plane is open to the internet.

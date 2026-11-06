# Upstream contract: `dsh web` (DeepSeek Harness)

Scope of this document: what the shell may rely on when it launches the **native
DeepSeek Harness web profile** inside an existing WSL distribution, and which
parts remain unverified. Verification date: M1 / R00–R01.

No command was executed inside the owner's Ubuntu distribution during R00/R01.
The contract below was verified from primary upstream sources (published npm
packages and their sources), not from a live server.

## Verified sources

| Package | Version inspected | Used for |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `0.2.1-rc.5` | CLI grammar: profile as first positional, `dsh web`, unknown flags forwarded to the app |
| `@deepseek-ai/dsh-web-app` | `0.2.1-rc.5` | web profile flags, `dsh web:` URL line, readiness signal, `--no-open`, config defaults |
| `@deepseek-ai/dsh-client-connection` | `0.2.1-rc.5` | token exchange, signed cookie lifetime, authority binding, 401 precedent |

All packages declare the same release train (`0.2.1-rc.5`) and the web bundle
lists `@deepseek-ai/dsh-web-app` as its surface.

## Launch contract

```sh
dsh web --host 127.0.0.1 --port <port> --no-open
```

- `web` is the profile name (`dsh <name>` == `dsh --profile <name>`); every flag
  the launcher does not recognize belongs to the web app.
- `--host` accepts exactly one concrete local address and rejects wildcards.
  The shell always passes `127.0.0.1`; a loopback-only listener is the only
  supported topology.
- `--port` selects the listener port. Upstream default is `3080`.
- `--no-open` suppresses the server's own browser handoff. Without it, the
  backend would try to open a Linux browser and print a credential-free
  diagnostic if that fails.
- The invoking directory is the workspace root, so the shell starts the process
  with `--cd <workspace>` inside the distribution.
- `--tls-cert`/`--tls-key`, `--public-url` and `--trusted-host` exist upstream
  but are deliberately **not** used: the shell is loopback HTTP only.

## Startup URL line (readiness signal)

After the plugin tree settles, the required-startup audit passes and connection
authentication is available, the process prints exactly one line:

```text
dsh web: http://127.0.0.1:<port>/?token=<process-token>
```

`lib/index.js` of `@deepseek-ai/dsh-web-app` constructs it as
`console.log("dsh web: " + authenticatedUrl)` and upstream documents the line as
the readiness announcement used by supervisors. Therefore:

- the line is a **safe readiness signal** — no polling race is required;
- the token is **per process** and regenerated on every launch;
- the URL is the advertised root (`http://127.0.0.1:<port>`) plus `?token=...`
  when no `--public-url` is configured.

The shell parses only that exact shape (`src/main/backend/urls.ts`): scheme
`http:`, host `127.0.0.1`, the configured port, path `/`, no fragment, no
credentials and a single `token` query parameter. Anything else is rejected and
logged without the URL or token.

## Session authentication

- `GET /?token=...` is the login exchange: the server writes a signed,
  host-only, `HttpOnly`, `SameSite=Strict`, `Path=/` cookie bound to
  `hostname:port` and redirects to `./`, dropping the token.
- The cookie signing secret is persisted in `$DSH_HOME/.credentials.yaml`, so a
  cookie survives backend restarts; the *token* does not.
- Cookie lifetime defaults to 30 days (`cookieMaxAgeDays`).
- Static assets are public; only the index document and API calls require the
  cookie. An unauthenticated index request answers **401**.

Consequences implemented by the shell:

1. The tokenized URL is sent **once**, from the Electron main process through the
   isolated session (`ses.fetch`), so the token never enters the renderer, the
   history, a window title or the log.
2. The window then loads the clean origin `http://127.0.0.1:<port>/`.
3. After a backend restart the stored cookie is probably still valid, so the
   shell tries a plain health request first and only falls back to restarting the
   owned process when the cookie is rejected (401/403).

## Failure modes referenced by upstream

| Situation | Observed upstream behaviour | Shell handling |
| --- | --- | --- |
| Frontend `dist` missing | startup stops with a build hint | terminal `ERROR` with the log hint |
| Port already bound | startup fails, process exits | fail closed **before** spawning: the shell refuses to adopt an unknown listener |
| Browser handoff impossible | credential-free diagnostic on stderr, server keeps running | irrelevant, `--no-open` is always passed |
| Config/profile fatal error | non-zero exit | `ERROR`, bounded retry, actionable message |

## Unknowns (must be confirmed in R02)

1. **Installed version of the owner's environment** — the contract above is
   verified for the `0.2.x` package train. `dsh --version` inside the
   distribution must confirm the actual version before R02 acceptance.
2. **How `dsh` was installed** — global npm prefix, npm-global, nvm, volta or a
   checkout. The shell probes the usual absolute paths, then `command -v dsh`,
   then a login shell, and supports an explicit executable path in Settings.
3. **WSL2 loopback forwarding** — the app reaches the Linux listener through
   Windows `127.0.0.1`. The distribution must have `localhostForwarding`
   enabled (WSL default). If Windows cannot reach the port while Linux can, the
   shell reports a health failure; this needs a real measurement in R02.
4. **Exact text of the missing-frontend error** and the exit code that
   accompanies it (documented only as "startup stops with a build hint").
5. **Whether `dsh web` prints any extra lines before the URL** (banner, warnings)
   — the parser ignores every non-matching line, so this only affects log noise.
6. **Cookie lifetime interaction** with a long-suspended WSL distribution
   (timer drift inside a suspended VM) — untested.

## Deliberate non-goals

- No `--public-url`, TLS, or non-loopback binding.
- No plugin/config/profile modification of the user's Windows DeepSeek Harness
  installation.
- No automatic installation or upgrade of Node, `dsh` or WSL distributions.
- No `wsl --shutdown`, no port-wide or distro-wide process killing.

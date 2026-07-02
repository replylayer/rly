# ReplyLayer CLI — machine interface

This document is the stable contract for programmatic consumers (agents, CI,
scripts) of the `replylayer` / `rly` CLI: the `--json` output shapes for the
diagnostic commands and the process exit-code semantics.

The **exit-code table below is the single canonical authority for every command**
(not just the diagnostic ones). Per-command `--json` *business output* (send,
inbox, etc.) is documented in `packages/cli/CLI_GUIDE.md`, which references this
table for exit semantics rather than redefining it.

## Exit codes

| Code | Meaning | Emitter |
|------|---------|---------|
| `0` | Success. `doctor` exits `0` when no check has `error` severity (warnings do not fail it). A `send`/`draft send` whose message was **created** but the scanner returned `status: blocked` / `quarantined` / `pending_review` also exits `0` — the request produced a message; read the JSON `status` for the outcome. | binary |
| `1` | Remote / API / runtime failure — the catch-all for API errors and unexpected failures, **including every gate-reject that produced no message** (`RATE_LIMITED`, `REPLY_LOOP_DETECTED`, `RECIPIENT_NOT_ON_ALLOWLIST`, `RECIPIENT_UNDELIVERABLE`, thread-mode `4xx`, `CONFIRM_REQUIRED`) and the `draft send` rejections `DRAFT_REJECTED_BY_RESCAN` / `DRAFT_ALREADY_SENT`. Discriminate on the JSON `code`, not a distinct exit code. | binary |
| `2` | Local usage / configuration error (bad flags, invalid local input). | binary |
| `3` | Authentication required / invalid — **opt-in only** (see below). | binary |
| `4` | **`send`/`reply` under `--strict` only:** the governed email-effect resolved `blocked` — a terminal content rejection (edit or escalate; never blindly retry). Not emitted without `--strict` (a block is exit `0` then). See [Strict send/reply exit codes](#strict-sendreply-exit-codes-4-5-6). | binary |
| `5` | **`send`/`reply` under `--strict` only:** the governed email-effect resolved `held_infrastructure` — a transient infrastructure hold / indeterminate dispatch; retry later, content was never judged. | binary |
| `6` | **`send`/`reply` under `--strict` only:** the governed email-effect resolved an **unrecognized** `effect_status` — fail-closed so a scripted agent never marks the task done on an outcome this CLI build cannot interpret. Upgrade `rly` to learn the new value. | binary |
| `124` | Timeout. **Owned by the PyPI `rly` launcher** (subprocess `TimeoutExpired`). | launcher |
| `127` | Bundled binary missing / not launchable. | launcher |
| `130` | A declined interactive confirmation (`USER_ABORTED`) — emitted by the **binary**. SIGINT / KeyboardInterrupt — emitted by the **launcher**. Both share the conventional "user interrupted" code. | binary / launcher |

**Business outcome vs. failure:** exit `0` means "the request was accepted and produced a message in some state" (branch on the JSON `status`); exit `≥1` means "the request did not produce a message" (branch on the JSON `code`). A scanner *block* is exit `0` with `status:"blocked"`; a *gate-reject* — including a `draft send` rescan rejection — is exit `1` with a `code`. There is no distinct exit code per business outcome; the `code` field is the machine discriminator.

The CLI binary deliberately **does not** emit `124`, and does not emit `130` for a
*signal* interrupt (SIGINT) — the PyPI `rly` launcher owns those subprocess
outcomes (it emits `124` on subprocess timeout and `130` on SIGINT /
KeyboardInterrupt; if the binary also produced them, a caller going through `rly`
could not distinguish a launcher timeout/interrupt from a CLI-internal one). The
binary **does** use `130` for a deliberate `USER_ABORTED` — an interactive
confirmation declined at the prompt (e.g. `mailbox delete` without `--confirm`) —
which shares the conventional "user interrupted" exit code; the launcher passes
that through unchanged.

### Auth exit code (`3`) is opt-in

By default, authentication failures (missing or invalid API key) exit `1`, so
existing scripts that branch on `$? -eq 1` to trigger a re-login keep working.
Set `REPLYLAYER_AUTH_EXIT_CODE=1` to map auth failures to the distinct code `3`:

- a missing key (`API_KEY_REQUIRED`), or
- an API `401 Unauthorized`.

This opt-in is intended to become the default in a future major release.

### Strict send/reply exit codes (`4`, `5`, `6`)

By default `rly send` and `rly reply` exit `0` on every outcome that produced a message — including a scanner `blocked` — and you branch on the JSON `status` / `email_effect.effect_status`. Passing `--strict` (which forwards `Prefer: outcome=strict` to the API) instead maps a non-delivered governed email-effect to a distinct non-zero exit so a scripted agent can branch on `$?` alone:

| `effect_status` | `--strict` exit | Meaning |
|---|---|---|
| `sent` | `0` | Delivered. |
| `held_for_review` | `0` | Accepted into governance, human-releasable — not a failure. |
| `blocked` | `4` | Terminal content rejection — edit or escalate; never blindly retry. |
| `held_infrastructure` | `5` | Transient infrastructure hold / indeterminate dispatch — retry later; content was never judged. |
| *(unrecognized)* | `6` | Fail-closed for a value this CLI build does not know. Upgrade `rly`. |

These codes are emitted **only** under `--strict`; without it the same outcomes are exit `0`. The mapping is applied identically on the fresh send and on the idempotent-replay path, so a replayed blocked send under `--strict` still exits `4` (never a false `0`). Codes `4`/`5`/`6` are reserved for this mapping — `3` (auth) is never reused, and the launcher owns `124`/`127`/`130`.

## `version --json`

```jsonc
{
  "version": "0.6.0",        // CLI version (matches `--version`)
  "commit": "unknown",        // git SHA the binary was built from; "unknown" in source mode
  "build_time": null,         // ISO build timestamp, or null when not embedded
  "channel": "dev",           // "dev" | "rc" | "stable"  (source builds are always "dev")
  "os": "linux",              // process.platform
  "arch": "x64",              // process.arch
  "runtime": "node-source",   // "node-sea" (bundled binary) | "node-source"
  "node_version": "v22.x.x",  // embedded/host Node version
  "artifact_name": null       // release asset name, or null in source mode
}
```

Bare `rly version` prints only the single version line (identical to
`rly --version`). A source-mode build always reports `channel: "dev"`,
`commit: "unknown"`, and `runtime: "node-source"` — it never claims `stable`.

## `config show --json`

```jsonc
{
  "api_url": "https://api.replylayer.ai",
  "credential_source": "file",          // "flag" | "env" | "file" | "none" — SOURCE only, never the key
  "config_dir": "/home/you/.replylayer",
  "legacy_credential_file": { "path": "/home/you/.replylayer/credentials", "present": true },
  "env": {
    "REPLYLAYER_API_URL": false,        // booleans: is the env var set?
    "REPLYLAYER_MAILBOX": false,
    "HTTPS_PROXY": null,                 // redacted URL string, or null  (user:pass → ***:***)
    "HTTP_PROXY": null,
    "NO_PROXY": null,
    "NODE_EXTRA_CA_CERTS": null          // file path verbatim (not a secret), or null
  }
}
```

`config show` requires no authentication and makes no network calls. The API key
is never printed — only its resolution source. Proxy URLs that embed credentials
are redacted before display.

## `doctor --json`

```jsonc
{
  "ok": true,                  // true when no check has "error" severity
  "checks": [
    { "id": "cli_version", "title": "CLI version", "severity": "ok",   "detail": "0.6.0 (dev, node-source)" },
    { "id": "runtime",      "title": "Runtime",      "severity": "ok",   "detail": "linux/x64, node v22.x.x" },
    { "id": "libc",         "title": "libc",         "severity": "ok",   "detail": "glibc 2.x" },
    { "id": "api_url",      "title": "API URL",      "severity": "ok",   "detail": "https://api.replylayer.ai" },
    { "id": "tls_custom_ca","title": "Custom CA",    "severity": "ok",   "detail": "no NODE_EXTRA_CA_CERTS set" },
    { "id": "proxy",        "title": "HTTP(S) proxy","severity": "ok",   "detail": "no proxy env set" },
    { "id": "credential",   "title": "Credential",   "severity": "warn", "detail": "no API key configured ..." },
    { "id": "secure_store", "title": "Secure credential store", "severity": "skip", "detail": "... not yet implemented" },
    { "id": "config_perms", "title": "Credential file permissions", "severity": "skip", "detail": "no credential file" },
    { "id": "legacy_plaintext", "title": "Plaintext credential", "severity": "ok", "detail": "no plaintext credential file" },
    { "id": "connectivity", "title": "API connectivity", "severity": "ok", "detail": "api.replylayer.ai reachable (HTTP 200, 84ms)" },
    { "id": "auth",         "title": "Auth validity", "severity": "ok",   "detail": "API key accepted (GET /v1/accounts/quota)" }
  ]
}
```

- `severity` is one of `ok` | `warn` | `error` | `skip`. Only `error` makes
  `doctor` exit non-zero.
- Network checks (`connectivity`, `auth`) are bounded by a per-check timeout
  (default 4000 ms, override with `REPLYLAYER_DOCTOR_TIMEOUT_MS`) and are
  skipped entirely under `--offline` / `--skip-network`.
- `doctor` works unauthenticated; the `auth` check is `skip` when no credential
  is present.

## Supply chain (SBOM, signatures)

Each release ships GPG-signed `SHA256SUMS` + a SLSA build-provenance attestation
over the binaries/wheels. The per-platform **SBOM** — its design, contents, the
local `pnpm --filter ./packages/cli sbom:sea` repro, and the `node_source`
provenance semantics — is documented in [`cli-sbom.md`](./cli-sbom.md).

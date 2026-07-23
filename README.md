# rly

The command-line interface for **ReplyLayer** — safe email for AI agents. Send,
receive, reply to, and security-scan transactional and operational email from
the terminal or from an agent loop. Not a bulk or marketing tool.

ReplyLayer provides safe email infrastructure for AI agents: mailboxes, sending, inbox workflows, scanning, quarantine, and approval flows designed for automated systems.

Command names: `rly` and `replylayer` (identical) — examples below use the shorter `rly`.

## Install

### npm

The official npm package is `rly` — the same name as on PyPI. It installs both the `rly` and `replylayer` commands. (The package was previously published as `replylayer`; that name is deprecated.)

```bash
npm i -g rly
rly --help
```

Requires Node.js 22 or higher. The npm package is the JavaScript CLI — it runs
on your host Node runtime, so both installing and running it need Node 22+.

### PyPI

The PyPI package is `rly`. Use `pipx` for a global CLI install. On supported
platforms the wheel ships a **bundled native binary** — it needs Python 3.10+
but no Node toolchain to install or run.

```bash
pipx install rly
rly --help
```

On Debian and Ubuntu systems that enforce PEP 668, plain `pip install rly` may fail with `externally-managed-environment`. Use `pipx install rly`, or install inside a virtual environment.

### winget (Windows x64)

The winget package is `ReplyLayer.CLI`. It needs no Node or Python toolchain.

```powershell
winget install --id ReplyLayer.CLI -e
rly --help
```

**Windows x64 only** — there is no arm64 package — and it installs the `rly`
command alone, not the `replylayer` alias. The installer is the Windows x64
binary published on this repository's releases, and its hash is pinned in the
winget manifest from the same GPG-signed `SHA256SUMS` described below.

Submitting to the winget community source is a manual step in our release
process, so this package can trail the newest npm/PyPI release — sometimes by
more than one version. `npm i -g rly` is always the first channel to carry a new
release; use it if you need the latest immediately.

To update or remove:

```powershell
winget upgrade --id ReplyLayer.CLI -e
winget uninstall --id ReplyLayer.CLI -e
```

### Install-channel collisions

npm, pipx, and winget can each put an `rly` on your `PATH`. Your shell runs
whichever comes first, so a fresh `winget install` can look like it did nothing
or installed an old version when an earlier npm or pipx install is actually
winning.

Keep one global install channel active at a time. To see which executable is
live:

```powershell
Get-Command rly -All   # Windows PowerShell (or: where.exe rly)
```

```bash
which -a rly   # macOS / Linux
```

In PowerShell, bare `where` is an alias for `Where-Object`, not the `where.exe`
program — use one of the two forms above.

Then remove the channels you are not using:

```powershell
winget uninstall --id ReplyLayer.CLI -e
npm uninstall -g rly
pipx uninstall rly
```

`rly --version` reports the version of whichever executable actually ran —
compare it against the channel you expect before filing an issue.

## Quickstart

```bash
export REPLYLAYER_API_KEY=rly_live_k3m9p2qx7vn4hjd0.uZ8Qb1vK3mN0pR7sT2wX9yA4cF6gH8jL1nP3rT5vW7z  # from app.replylayer.ai
rly doctor --json                                # confirm auth + connectivity (ok: true)
rly send --from <mailbox> --to delivered@simulator.replylayer.net \
  --subject "hello" --body "first send" --json
# → branch on the JSON `status`: sent | quarantined | blocked | pending_review
```

`delivered@simulator.replylayer.net` (ReplyLayer's own first-party simulator) is the
zero-setup first-send target — the send is accepted immediately and a genuine
`message.delivered` webhook fires a few seconds later. The send flag is
`--from <mailbox>` (mailbox name or ID). See "Simulator" below for the full scenario
list and `rly simulate inbound` (synthetic inbound testing).

## Auth

A single API key. `REPLYLAYER_API_KEY` (env var, wins over stored creds), or
`rly auth login`, or `--api-key`. Production (`https://api.replylayer.ai`) is the
default endpoint — set nothing else. `REPLYLAYER_API_URL` is a testing-only override.

A new key is **inert** on protected product routes until a human completes both
signup checks: the emailed 6-digit code (`rly auth verify --code <code>`) and the
6-digit SMS code (`rly auth verify-phone --code <code>`). `EMAIL_NOT_VERIFIED` or
`PHONE_NOT_VERIFIED` means that bootstrap is incomplete. If the SMS was not sent,
run `rly auth resend-phone`; before verification, add `--phone +<country-code>...`
to correct a typo and resend.

## For agents: `--json` and exit codes

Every command supports the global `--json` flag for machine-readable output (errors go
to stderr as a single JSON object with a stable `code`).

**Branch on the JSON `status`, not the exit code.** A scanner block is exit `0` with
`status: "blocked"` (the message was created and a policy decision recorded). A
gate-reject (rate limit, allowlist, undeliverable recipient, draft rescan-reject) is
exit `1` with a stable `code` and no message created.

| Exit | Meaning |
|------|---------|
| `0` | The request produced a message — read the JSON `status` (`sent` / `quarantined` / `blocked` / `pending_review`). |
| `1` | Remote / API / runtime failure, including every gate-reject — discriminate on the JSON `code`. |
| `2` | Local usage / configuration error (bad flags). |
| `3` | Auth required / invalid. Defaults to exit `1`; set `REPLYLAYER_AUTH_EXIT_CODE=1` to receive this distinct code. |
| `130` | Interrupted, or an interactive confirmation aborted (`USER_ABORTED`). |

`send`/`reply` with `--strict` add three outcome codes: `4` (blocked, terminal), `5` (infrastructure hold, retryable), and `6` (unrecognized outcome, fail-closed). Without `--strict` a non-delivered outcome stays exit `0`.

This table is the agent-facing exit-code contract; the full command reference is in the bundled `CLI_GUIDE.md`.

A typical agent monitoring loop anchors a `--since` cursor so it waits for the next
arrival instead of reprocessing the backlog (reading does NOT mark a message read):

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MSG=$(rly --json inbox wait --mailbox support-bot --since "$SINCE" --timeout 30)
# exit 0 with .message=null means "polled cleanly, nothing arrived" — not an error.
```

## Simulator

Test send, provider-style outcomes, webhook signatures, and inbound receive/quarantine
without a real recipient or another provider's simulator:

```bash
rly send --from <mailbox> --to bounced@simulator.replylayer.net --subject hi --body hi
rly simulate inbound --mailbox <mailbox> --scenario clean
rly simulate inbound --mailbox <mailbox> --scenario prompt_injection_quarantined
rly webhook test <id> --event message.delivered
```

Outbound scenarios: `delivered@`, `bounced@`, `complained@`, `suppressed@` at
`simulator.replylayer.net` (append `+label` for your own correlation, e.g.
`delivered+run-1@simulator.replylayer.net`). `complained@`/`suppressed@` prove webhook
delivery only — no real suppression row is written. One Sandbox account can run all
four scenarios in the same day; the exact simulator addresses bypass the
recipient-domain cap but still consume daily and cumulative send allowances. Full
detail is in `CLI_GUIDE.md`;
the canonical outcome, accounting, and inbound-response contract is the
[email simulator guide](https://replylayer.ai/docs/guides/simulator).

## Package Links

- npm: https://www.npmjs.com/package/rly
- PyPI: https://pypi.org/project/rly/
- winget: https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/ReplyLayer/CLI

## Verifying a release

Every CLI release publishes a GPG-signed checksum manifest so you can verify a
download. The signing key is in [`KEYS.txt`](./KEYS.txt) in this repository.

**What the manifest covers:** the **PyPI wheels and sdist** (byte-identical to
the files on PyPI) and the platform binaries. The **npm** package is *not*
covered by this manifest; verify npm registry signatures separately with `npm
audit signatures`.

1. Download the manifest, its signature, and the signing key:

   ```bash
   base=https://github.com/replylayer/rly/releases/latest/download
   curl -fsSLO "$base/SHA256SUMS"
   curl -fsSLO "$base/SHA256SUMS.sig"
   curl -fsSL https://raw.githubusercontent.com/replylayer/rly/main/KEYS.txt | gpg --import
   ```

2. Verify the manifest signature — expect
   `Good signature from "ReplyLayer CLI Releases <cli-releases@replylayer.ai>"`:

   ```bash
   gpg --verify SHA256SUMS.sig SHA256SUMS
   ```

3. Verify the file you actually downloaded. The manifest lists every release
   artifact — including binaries not attached to this repo — so check **only
   your file** with a filtered match. A bare `sha256sum -c SHA256SUMS` would
   fail on the absent entries.

   ```bash
   # GNU/Linux: verify every listed file you actually have, skip the rest
   sha256sum --ignore-missing -c SHA256SUMS

   # any platform: verify one file by name (replace with your download)
   grep '<your-downloaded-file>' SHA256SUMS | sha256sum -c
   ```

   On macOS use `shasum -a 256 -c` in place of `sha256sum -c` (the `grep` form).

## Security

Please report security issues privately to `security@replylayer.ai`.

## Source

This repository is a public install and package-trust surface for ReplyLayer's CLI. The main product source is maintained separately, and a standalone public CLI source checkout is not yet available here. Install the JavaScript CLI with npm on Node.js 22+, or use the bundled PyPI wheel with pipx on a supported platform.

## `langchain-python/` — LangChain adapter source mirror

[`langchain-python/`](./langchain-python) is a read-only source mirror of the [`langchain-replylayer`](https://pypi.org/project/langchain-replylayer/) PyPI package, updated automatically at each release and proven byte-identical to the released sdist. File issues here; pull requests against this directory cannot be merged directly — it is regenerated from the upstream source at every release.

The npm package carries its own runtime.

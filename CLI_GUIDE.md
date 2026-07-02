# ReplyLayer CLI Guide

The ReplyLayer CLI gives your AI agent (or you) direct access to email from the terminal. Send, receive, search, and manage mailboxes without touching a browser.

## Installation

### npm (recommended)

```bash
npm i -g rly
```

Requires Node.js 22 or higher.

**Supported platforms (prebuilt binary):** Linux x86_64 / aarch64 (glibc 2.28+),
macOS arm64 / x86_64 (≥ 14.0), Windows x64. The bundled native binary is
glibc-linked, so **Alpine / musl is not supported** — on a musl base image,
install via npm on host Node 22+ (or set `RLY_FORCE_NPX=1`).

### PyPI alias

```bash
pipx install rly
rly --help
```

Installing the `rly` PyPI package exposes **both** the `rly` and `replylayer`
commands (same launcher, two names) — matching the npm package. Examples use the
short form:

```bash
rly --help   # the `replylayer` command is an identical legacy alias
```

On Debian and Ubuntu systems that enforce PEP 668, plain `pip install rly` may fail with `externally-managed-environment`. Use `pipx install rly` for a global CLI install, or run `pip install rly` inside a virtual environment.

### pnpm

```bash
pnpm add -g rly
```

### From source

The CLI source is published at <https://github.com/replylayer/rly>:

```bash
git clone https://github.com/replylayer/rly.git
cd rly
npm install
npm run build
npm link
```

#### Prerequisites (source build)

Building from source requires **Node.js ≥ 22 on your `PATH`** (the package's
`engines.node` field). A host whose `PATH` Node is older than 22 — or where
`node.exe` is ACL-restricted (a common Windows lock-down) — fails during
`npm install`. That is a **host toolchain issue, not a CLI
regression**: the sources compile cleanly on a compliant
host. If you cannot run a recent Node toolchain, prefer the published bundled
binary — `npm i -g rly` or `pipx install rly` — which carries its own
runtime and has **no Node requirement** at all.

## Authentication

### Store an API key

```bash
rly auth login
# Prompts for your API key and stores it in ~/.replylayer/credentials (mode 0600)
```

### Use an environment variable

```bash
export REPLYLAYER_API_KEY=rly_live_k3m9p2qx7vn4hjd0.uZ8Qb1vK3mN0pR7sT2wX9yA4cF6gH8jL1nP3rT5vW7z
rly inbox list --mailbox support-bot
```

### Pass inline (one-off)

```bash
rly --api-key rly_live_k3m9p2qx7vn4hjd0.uZ8Qb1vK3mN0pR7sT2wX9yA4cF6gH8jL1nP3rT5vW7z mailbox list
```

### Check auth status

```bash
rly auth status
# Authenticated: yes
# Source: env (REPLYLAYER_API_KEY)
```

## Quick Start

```bash
# Create an account at public launch (mint a CLI signup code from the dashboard first)
rly signup --email you@example.com --accept-terms --accept-web-risk \
  --cli-signup-code rls_cli_<code>

# During invite-only period, use --invite-code instead
rly signup --email you@example.com --accept-terms --accept-web-risk --invite-code <code>

# Verify your email (check inbox for 6-digit code)
rly auth verify --code 482917

# Create a mailbox
rly mailbox create support-bot

# Add a recipient — validates the address, then sends a confirmation email (required for sandbox tier)
rly recipients add customer@example.com

# Send an email
rly send --from support-bot --to customer@example.com \
  --subject "Hello" --body "Your order has shipped."

# List messages
rly inbox list --mailbox support-bot

# Read a message
rly inbox read <message-id>

# Reply to a message
rly reply <message-id> --body "We're looking into this."

# Wait for new messages (long-poll)
rly inbox wait --mailbox support-bot --timeout 30
```

## Commands

### Account

```bash
# Public launch — dashboard-issued code creates a SEPARATE new account
rly signup --email you@example.com --accept-terms --accept-web-risk \
  --cli-signup-code rls_cli_<code>

# Invite-only environments — operator-issued invite code
rly signup --email you@example.com --accept-terms --accept-web-risk --invite-code <code>

rly account usage                                   # Usage + tier limits (admin key)
rly account quota                                   # Send-budget preflight: daily cap, sends remaining, reset time (works with agent keys)
rly account export                                  # Export your account data as JSON (GDPR portability)
rly account export --out account.json               # Write the export to a file (mode 0600)

rly account link-scanning status                    # Malicious link scanning (URL reputation) on/off (any key)
rly account link-scanning enable --accept           # Turn it on (admin key; --accept acknowledges the disclosure)

rly account delete                                  # Soft-delete (30-day grace)
rly account delete --confirm                        # Skip confirmation prompt
```

`account quota` is the canonical send-budget preflight for an agent loop — unlike `account usage` (admin key only), it works with an agent-scoped key.

`account link-scanning` controls malicious link scanning — inbound links checked against Google Web Risk (only SHA-256 hash-prefixes are sent; full URLs never leave the platform). `status` works with any key; `enable` is an admin action (it turns on an account-wide sub-processor data flow) and **requires `--accept`** — without it the command prints the disclosure and exits non-zero (`LINK_SCANNING_ACCEPT_REQUIRED`) without changing anything. In `--json` mode the disclosure free-text is suppressed (JSON-safe) and `--accept` is still required. If your account's accepted privacy policy predates this feature, re-accept the current Privacy Policy in the dashboard first.

### Authentication

```bash
rly auth login       # Store API key
rly auth logout      # Remove stored key
rly auth rotate      # Rotate API key (revokes current)
rly auth status      # Show auth status
rly auth verify --code <code>   # Verify email with 6-digit code
rly auth resend --email <email> # Resend verification code
```

**Email verification notes:** Verification codes are valid for **10 minutes**. If you did not receive the email, first check your spam folder — then use `auth resend` to request a new code. Resends are rate-limited to **3 per hour per IP address**. If your current code has not yet expired you will get the same success response without a new email being sent; this is by design (anti-abuse). If `auth verify` reports `VERIFICATION_CODE_EXPIRED`, run `auth resend` to get a fresh code.

### Mailboxes

```bash
rly mailbox create support-bot      # Create a mailbox
rly mailbox list                    # List all mailboxes
rly mailbox delete support-bot      # Soft-delete a mailbox
rly mailbox delete support-bot -y   # Skip confirmation
```

### Sending Email

```bash
# Basic send
rly send --from support-bot --to user@example.com \
  --subject "Update" --body "Your ticket is resolved."

# With HTML
rly send --from support-bot --to user@example.com \
  --subject "Update" --body "Resolved." --html "<p>Resolved.</p>"

# Reply to a message
rly reply <message-id> --body "Thanks for reaching out."

# Continue an existing thread (mailbox + subject are derived from the thread)
rly send --thread <thread-id> --body "Following up on your request."

# Thread send with an explicit mailbox disambiguator (when a thread spans mailboxes)
rly send --thread <thread-id> --from support-bot --body "Update from support."
```

In thread mode (`--thread`), `--from` and `--subject` are optional — they are derived from the thread — and `--to` is an optional participant selector; this is the path for continuing an inbound conversation. The CLI sends synchronously (the response carries `status` + the scan verdict). The async optimistic-ack path is REST-only and draft-send-only: `POST /v1/drafts/:id/send` with header `Prefer: respond-async`, then poll `GET /v1/messages/:id`.

By default, `send` and `reply` exit `0` even when the scanner blocks or holds the message — read the JSON `status` field for the outcome. Pass `--strict` (send/reply only) to make a non-delivered outcome exit non-zero instead, which is easier to branch on in scripts and agent loops:

```bash
# Fail the command (non-zero exit) if the message is not delivered
rly send --from support-bot --to user@example.com \
  --subject "Update" --body "Your ticket is resolved." --strict
```

With `--strict`, a scanner **block** exits `4`, an **infrastructure hold** (retryable) exits `5`, and an unrecognized outcome exits `6` (fail-closed). A human-releasable review hold and a delivered message still exit `0`.

### Drafts

Drafts give you a scan-then-review-then-send workflow: create a draft (the scanner runs immediately and the verdict is attached), inspect it, then send — which re-runs the scanner authoritatively at send time.

```bash
# Create a draft (scanner runs immediately; verdict attached to the draft)
rly draft create --mailbox support-bot --to user@example.com \
  --subject "Update" --body "Your ticket is resolved."

# List drafts for a mailbox, or show one with its scan verdict
rly draft list --mailbox support-bot
rly draft show <draft-id>

# Edit a draft (re-runs the scanner)
rly draft update <draft-id> --body "Revised body."

# Send a draft (authoritative rescan at send time)
rly draft send <draft-id>

# Discard a draft
rly draft delete <draft-id>

# Reply-draft into a thread, or schedule a send for later
rly draft create --thread <thread-id> --body "Reply body."
rly draft create --mailbox support-bot --to user@example.com \
  --subject "Reminder" --body "Just checking in." --send-at 2026-07-01T09:00:00Z
```

`draft send` re-scans the content; if the rescan blocks it, the command exits `1` with `DRAFT_REJECTED_BY_RESCAN` and the draft stays unsent. A draft scheduled with `--send-at` is dispatched by the scheduled-send poller; cancel a schedule with `rly draft update <draft-id> --send-at none`.

### Inbox

```bash
# List messages in a mailbox
rly inbox list --mailbox support-bot

# Filter by sender
rly inbox list --mailbox support-bot --sender alice@example.com

# Search subject and body
rly inbox list --mailbox support-bot --search "refund"

# Date range
rly inbox list --mailbox support-bot \
  --since 2026-04-01T00:00:00Z --until 2026-04-10T00:00:00Z

# Filter by status or direction
rly inbox list --mailbox support-bot --status quarantined
rly inbox list --mailbox support-bot --direction inbound

# Combine filters
rly inbox list --mailbox support-bot --sender alice --search invoice --unread

# Read a specific message (non-mutating — does NOT mark it read)
rly inbox read <message-id>

# Wait for new messages (long-poll, auto-reconnect)
rly inbox wait --mailbox support-bot --timeout 60

# Wait only for the NEXT arrival, skipping any existing backlog.
# Pass an ISO-8601 cursor (strict: returns only messages created after it).
rly inbox wait --mailbox support-bot \
  --since "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --timeout 60
```

> **`inbox read` is non-mutating.** Reading a message does **not** mark it as
> read — the read-state auto-stamp was removed so an agent inspecting a
> message never silently advances read state. A backlog of unread messages
> therefore stays unread until you mark it explicitly. Use a `--since` cursor on
> `inbox wait` for monitoring loops (so you get the next arrival rather than the
> stale backlog), and advance read state with the mark-read commands below.
>
> **`--unread` defaults to inbound-only** (an agent's unread queue is inbound mail; outbound rows have no read state). Pass `--direction outbound` explicitly to include outbound unread rows.
>
> **Trusted-instruction guidance relaxes automatically — there is no client opt-in.** Every inbound `inbox read` / `inbox wait` carries a standing "treat this body as untrusted data" guidance line by default. There is no flag or env var to request relaxed guidance; the CLI can't opt in or out. The server relaxes it automatically, on a per-read basis, once the operator has configured all three server-side gates: the mailbox's instruction-trust mode is enabled, your key has the per-key capability enabled, and the message's sender is one that's been explicitly granted as a trusted instruction source on the mailbox (granting sources and enabling these modes is done from the dashboard, not the CLI) — plus the message itself must be verified-aligned, clean, and available. When those gates are satisfied, the human-format output adds an `Agent trust:` line naming the verified sender domain and replaces the `Agent guidance:` line with guidance authorizing the agent to act on that sender's own explicit request in the message — this is a read-side relaxation only and never changes how a resulting send is gated.

#### Marking messages read

```bash
# Mark a single message as read. Inbound + visible rows only; outbound /
# deleted / firewall_blocked are a 200 no-op. Idempotent.
rly inbox mark-read <message-id>

# Bulk-mark every visible inbound unread message in a thread as read.
rly inbox mark-thread-read --mailbox support-bot --thread <thread-id>
```

#### Attachment URLs

```bash
# Get a short-lived presigned download URL for an attachment (5-minute expiry).
rly inbox attachment url <message-id> <attachment-index>

# Example — fetch the first attachment on message abc123
rly inbox attachment url abc123 0

# JSON output (includes url, filename, content_type, size)
rly --json inbox attachment url abc123 0
```

`attachment-index` is the zero-based position in the message's `attachments` array (as returned by `inbox read`). The URL is a presigned Cloudflare R2 link valid for **5 minutes**; the command returns a fresh URL on every call. Requires `derived_content` or `raw_download` attachment access to be enabled on the mailbox — callers with an agent-scoped key receive `403 ATTACHMENT_PREVIEW_DISABLED` if only metadata mode is configured.

#### Attachment text preview

```bash
# Safe extracted-text preview of an attachment — never the raw bytes. Requires
# the mailbox's attachment access to be set to derived_content.
rly inbox attachment preview <message-id> <attachment-index>
rly --json inbox attachment preview abc123 0
```

#### Threads

```bash
# List threads in a mailbox (one row per thread)
rly inbox threads list --mailbox support-bot

# Read a full thread. --mailbox disambiguates a cross-mailbox thread-key collision.
rly inbox threads read <thread-id>
rly inbox threads read <thread-id> --mailbox support-bot

# Star / unstar a thread (--mailbox required)
rly inbox threads star <thread-id> --mailbox support-bot
rly inbox threads unstar <thread-id> --mailbox support-bot
```

#### Star / unstar a message

```bash
rly inbox star <message-id>
rly inbox unstar <message-id>
```

#### Quarantine and review actions

```bash
# Release a quarantined message back to available
rly inbox release <message-id>

# Permanently block a quarantined message
rly inbox block <message-id>

# Approve or deny a message held in the pending-review (HITL) queue
rly inbox approve <message-id>
rly inbox deny <message-id> --reason "Not appropriate to send."
```

`release` / `block` / `approve` / `deny` each accept an optional `--reason`. To release a message stopped by the inbound firewall (`firewall_blocked`) rather than the scanner, use the top-level `rly firewall-release <message-id>` (below).

### Recipients (Sandbox Tier)

Sandbox accounts can only send to confirmed recipients. Adding a recipient validates the address first, then sends a confirmation email — the recipient must click the link before you can send to them.

```bash
rly recipients add customer@example.com     # Validate, then send confirmation email
rly recipients list                          # List with confirmation status
rly recipients resend customer@example.com   # Re-send the confirmation email to a pending recipient
rly recipients remove customer@example.com   # Remove a recipient
```

Under enforce-mode validation, `recipients add` can fail with `RECIPIENT_VALIDATION_FAILED` for rejected addresses or `RECIPIENT_VALIDATION_UNAVAILABLE` when validation is temporarily unavailable.

### API Keys

Create scoped keys so each agent only accesses its assigned mailboxes.

```bash
# Create an agent key bound to a specific mailbox
rly api-key create --role agent --label support-bot-key --mailbox support-bot

# Create an admin key (full account access)
rly api-key create --role admin --label ops-key

# List all keys
rly api-key list

# Revoke a key
rly api-key revoke <key-id>

# Rotate the current key (revokes current, mints a fresh one, stores it)
rly api-key rotate
rly api-key rotate --dry-run    # Preview the rotation without revoking or issuing a key
```

`api-key rotate` replaces the stored credential atomically — the old key is revoked and the new key is persisted to `~/.replylayer/credentials` (or printed as JSON with `--json`) before the call returns. Any concurrent request in flight on the old key may receive `401`; re-try with the new key.

Agent keys can send, read, and reply on their bound mailboxes only. They cannot manage mailboxes, keys, scanner policies, or the account.

### Outbound Recipient Allowlist

The outbound allowlist gates which addresses a mailbox can send to. When enabled, a send to an address not on the list is rejected with `RECIPIENT_NOT_ON_ALLOWLIST` (exit 1). Mutations require an admin key.

```bash
# Add a single recipient to a mailbox's outbound allowlist
rly mailbox allowlist add support-bot user@example.com

# Add many recipients at once — --emails takes a comma-separated list or @file
rly mailbox allowlist add-bulk support-bot --emails alice@example.com,bob@example.com
rly mailbox allowlist add-bulk support-bot --emails @addresses.txt

# List current allowlist entries
rly mailbox allowlist list support-bot

# Remove an entry
rly mailbox allowlist remove support-bot user@example.com
```

`--emails` takes a comma-separated list or `@/path/to/file` (one address per line; blank lines are ignored). Up to 1000 entries per call. On completion the command prints `Bulk import: N added, N already existed, N invalid (N total)` — addresses already on the list are reported under `already existed` rather than re-added, and any rejected addresses are listed with their reasons.

### Inbound Sender Allowlist

The per-mailbox inbound sender allowlist controls who can deliver into a mailbox when `sender_policy_mode` is set to `allowlist`. Inbound mail from a sender not on the allowlist is quarantined as `firewall_blocked`.

```bash
# Add a single sender
rly mailbox inbound-allowlist add support-bot sender@example.com

# Add many senders at once — --emails takes a comma-separated list or @file
rly mailbox inbound-allowlist add-bulk support-bot --emails @senders.txt

# List current inbound allowlist entries
rly mailbox inbound-allowlist list support-bot

# Remove an entry
rly mailbox inbound-allowlist remove support-bot sender@example.com
```

Domain-wildcard entries (`@corp.com`) match all senders at that domain. `add-bulk` uses the same `--emails <csv|@file>` interface as the outbound allowlist (both admin and agent keys may manage the inbound allowlist).

### Suppressions (Do-Not-Contact)

Customer-managed do-not-contact list. A suppressed address is blocked on every outbound send path (before scanner, before allowlist). Requires an admin key.

```bash
# Add a single suppression
rly suppressions add user@example.com

# Add many suppressions at once — --emails takes a comma-separated list or @file
rly suppressions add-bulk --emails @suppressed.txt

# List suppressions
rly suppressions list

# Remove a suppression (returns 409 RECIPIENT_BLOCKLIST_COMPLAINT_LOCKED if
# the address has a recorded spam complaint — use the dashboard for overrides)
rly suppressions remove user@example.com
```

`add-bulk` uses `--emails <csv|@file>` (one address per line in a file; blank lines ignored; up to 1000 per call). Addresses are lowercased and deduplicated server-side.

### Account-wide Inbound Sender Blocklist

The account-wide inbound blocklist rejects delivery from specific senders or entire domains, regardless of which mailbox the message targets.

```bash
# Add a single blocked sender
rly inbound-blocklist add spammer@example.com

# Add a domain wildcard (blocks all senders at that domain)
rly inbound-blocklist add @spam-domain.com

# Add many entries at once — --emails takes a comma-separated list or @file
rly inbound-blocklist add-bulk --emails @blocked.txt

# List current blocklist entries
rly inbound-blocklist list

# Remove an entry
rly inbound-blocklist remove spammer@example.com
```

`add-bulk` uses the same `--emails <csv|@file>` interface as the other bulk commands. Domain wildcards (`@domain.com`) are accepted and match all senders at that domain.

### Scanner Policy

Customize which scanning criteria run on a per-mailbox basis.

```bash
# Disable PII detection on a mailbox
rly mailbox update support-bot --disable-scanner pii

# Tune outbound PII send safety by type (Pro+ for relaxed/review values)
rly mailbox update support-bot \
  --scanner-policy '{"outbound_pii_policy":{"ssn":"quarantine","credit_card":"review","phone_number":"allow"}}'

# Require an approval note before sending SSN / credit-card review holds (Pro+)
rly mailbox update support-bot \
  --scanner-policy '{"outbound_review_policy":{"approval_note":"required_for_sensitive_pii"}}'

# Allow multilingual inbound
rly mailbox update support-bot --language-mode allow_all_languages

# Disable multiple scanners + criteria
rly mailbox update support-bot \
  --disable-scanner pii --disable-scanner secrets \
  --disable-criterion confidentiality_leak

# Reset to platform defaults
rly mailbox update support-bot --reset-policy

# Set policy from JSON
rly mailbox update support-bot --scanner-policy '{"language_mode":"disabled","disabled_scanners":["pii"]}'
```

**Disableable scanners:** `prompt-injection`, `attachment-policy`, `mime-mismatch`, `pii`, `secrets`, `url-reputation`

**Disableable proxy criteria:** `prompt_injection`, `jailbreak`, `function_call_risk`, `profanity`, `confidentiality_leak`, `unauthorized_liability`

**Scanning is directional by design.** Outbound text that resembles prompt-injection is your agent's own authored content and is delivered clean, while inbound prompt-injection is quarantined; inbound credential-looking values are also delivered clean (the `secrets` scanner is outbound-only).

**Outbound PII actions:** `allow`, `allow_with_warning`, `review`, `quarantine`, `block` for `ssn`, `credit_card`, and `phone_number`. Platform defaults are `ssn=quarantine`, `credit_card=quarantine`, and `phone_number=allow_with_warning`. `review` routes matching sends to Pending approval and requires both Pro+ outbound PII controls and the review queue feature. Relaxing below defaults requires Pro+ (`pii_advanced_controls`); stricter/default values are accepted on every tier.

**Outbound approval notes:** `outbound_review_policy.approval_note` is `optional` by default. Set `required_for_sensitive_pii` to require an approval note before sending SSN or credit-card review holds.

`mailbox update` merges supplied scanner-policy keys with the current mailbox policy so setting `outbound_review_policy` does not wipe `outbound_pii_policy` or other sibling controls. Use `--reset-policy` when you intend to clear the full scanner policy back to platform defaults.

**Mandatory (cannot be disabled):** Outbound content safety (`toxicity`, `hate_speech`, `violence`, `harassment`, `self_harm`, `sexual_content`) and recipient check.

### Domains

Manage custom sending domains. ReplyLayer supports bring-your-own-domain (BYOD, sent via ReplyLayer's shared provider) and bring-your-own-email-server (BYOES, a self-hosted SMTP/IMAP transport).

```bash
# List and inspect domains
rly domain list
rly domain inspect <id>

# Add a BYOD domain (ReplyLayer-managed transport)
rly domain create example.com

# Add a self-hosted (BYOES) domain — SMTP/IMAP secrets are read from a no-echo
# prompt or piped stdin, never from argv
rly domain create example.com --transport self_hosted \
  --smtp-host smtp.example.com --smtp-port 587 --smtp-username relay@example.com

# Verify, re-probe, set the account default, or remove
rly domain verify <id>
rly domain recheck <id>            # Force a fresh self-hosted SMTP/IMAP probe
rly domain set-default <id>
rly domain delete <id>
```

Update an existing self-hosted domain's transport settings with `rly domain set-config <id> ...`. Run `rly domain create --help` / `rly domain set-config --help` for the full SMTP/IMAP option set.

### Webhooks

Subscribe to delivery events (message received, quarantined, scheduled-send outcomes, and more). Requires an admin key. Outbound payloads are HMAC-signed, and the SDKs verify signatures.

```bash
# Create a subscription (repeat --event for each event you want)
rly webhook create --url https://yourapp.example.com/hooks \
  --event message.received --event message.quarantined

# List / show
rly webhook list
rly webhook get <id>

# Update or delete
rly webhook update <id> --url https://new-url.example.com
rly webhook delete <id>

# Rotate the signing secret, send a test delivery, or inspect/retry deliveries
rly webhook rotate-secret <id>
rly webhook test <id>
rly webhook deliveries <id>
rly webhook retry <id> <delivery-id>
```

### Legal Holds (Pro+)

Apply compliance legal holds that preserve account or mailbox data through the normal deletion/purge lifecycle. Applying a hold requires an admin key and Pro+ tier; reading and releasing existing holds are not tier-gated.

```bash
rly legal-hold apply --scope account --reason "Litigation hold — matter 2026-001"
rly legal-hold apply --scope mailbox --mailbox <mailbox-id> --reason "Regulatory inquiry"
rly legal-hold list                       # Active holds (--include-released for history)
rly legal-hold get <hold-id>
rly legal-hold release <hold-id> --reason "Matter closed"
```

### Firewall Release

Release a message stopped by the inbound firewall (`firewall_blocked` — a blocked sender, or a sender not on the mailbox's allowlist) back into scanner processing.

```bash
rly firewall-release <message-id>
```

This is distinct from `rly inbox release`, which releases a message quarantined by the **content scanner**.

### Configuration

Inspect the CLI's effective configuration — no auth and no network call.

```bash
rly config show          # Resolved API URL, credential source, proxy env, config dir
rly --json config show   # Machine-readable
```

## Global Options

| Flag | Description |
|------|-------------|
| `-V, --version` | Print version number |
| `--api-url <url>` | API base URL (default: `https://api.replylayer.ai`, env: `REPLYLAYER_API_URL`) |
| `--api-key <key>` | API key (overrides stored credential, env: `REPLYLAYER_API_KEY`) |
| `--json` | Output JSON instead of formatted tables |
| `-h, --help` | Show help for any command |

## JSON Output

Every command supports `--json` for machine-readable output. Useful for piping into `jq` or integrating with agent frameworks.

```bash
# JSON output
rly --json inbox list --mailbox support-bot | jq '.messages[0].subject'

# JSON error output (goes to stderr)
rly --json mailbox create existing-name 2>&1 | jq '.error'
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `REPLYLAYER_API_KEY` | API key (alternative to `rly auth login`) |
| `REPLYLAYER_API_URL` | API base URL — **override-only**; defaults to prod `https://api.replylayer.ai`. See [Staging and self-hosted targets](#staging-and-self-hosted-targets). |
| `REPLYLAYER_MAILBOX` | Default mailbox for **fresh** `send --from` / `inbox list` / `inbox wait` / `draft create`. An explicit flag wins. NOT consulted in `--thread` mode or by `draft list` / `inbox mark-thread-read`. |

### Staging and self-hosted targets

`REPLYLAYER_API_URL` is **override-only**. The CLI defaults to the production
host `https://api.replylayer.ai`, so **real customers on production need to
set nothing**.

Set it (env var or `--api-url`) only when targeting a **non-production** API: a
staging account, a self-hosted deployment, or a local server. Point it at the
host your operator gave you for that environment — and prefer a stable hostname
over a provider-assigned one that can rotate.

```bash
# POSIX (bash/zsh)
export REPLYLAYER_API_URL=<your-non-production-host>
```

```powershell
# PowerShell
$env:REPLYLAYER_API_URL='<your-non-production-host>'
```

A `401 UNAUTHORIZED` on the first authenticated call against a staging key
almost always means the URL is still pointed at prod.

## Agent Integration

The CLI is designed to be called by AI agents. A typical agent loop:

```bash
# 1. Anchor the monitoring window so you wait for the NEXT arrival rather than
#    re-processing the existing backlog (reading does not mark messages read).
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 2. Wait for a new message. Exit code is meaningful: 0 = polled cleanly
#    (empty -> .message is null), nonzero = the endpoint was unreachable for the
#    whole timeout (do NOT treat as an empty inbox).
MSG=$(rly --json inbox wait --mailbox support-bot --since "$SINCE" --timeout 30)

# 3. Check if a message arrived
if echo "$MSG" | jq -e '.message != null' > /dev/null 2>&1; then
  MSG_ID=$(echo "$MSG" | jq -r '.message.id')

  # 4. Read the full message (non-mutating)
  FULL=$(rly --json inbox read "$MSG_ID")
  BODY=$(echo "$FULL" | jq -r '.body.content')

  # 5. Process with your agent and reply
  REPLY=$(your-agent-process "$BODY")
  rly reply "$MSG_ID" --body "$REPLY"

  # 6. Advance read state explicitly (reading did not).
  rly inbox mark-read "$MSG_ID"
fi
```

## Troubleshooting

**`Error: Network error: fetch failed`** — The CLI defaults to `https://api.replylayer.ai`. If running against a local server, set `REPLYLAYER_API_URL=http://localhost:3000`.

**`Error: Invalid API key`** — Check `rly auth status`. If using env var, verify `REPLYLAYER_API_KEY` is set. Keys start with `rl_live_` (legacy) or `rly_live_` (current).

**`Error: Mailbox 'X' not found`** — The `--from` and `--mailbox` flags accept either the mailbox name or UUID. Check `rly mailbox list`.

**`Error: Email not verified (EMAIL_NOT_VERIFIED)`** — Your account needs email verification before you can use the API. Check your inbox for a 6-digit code, then run `rly auth verify --code <code>`. If you didn't receive it, run `rly auth resend --email <your-email>`.

**`Error: Signups are currently invite-only`** — The platform requires an invite code during the pre-launch period. Add `--invite-code <code>` to your signup command.

**`CLI_SIGNUP_CODE_REQUIRED`** — At public launch the CLI requires a dashboard-issued signup code to create a **separate** new account. **New to ReplyLayer?** Create your first account at `https://app.replylayer.ai/signup`, then sign in. **Already have an account?** Sign in at `https://app.replylayer.ai`, navigate to the "Additional CLI accounts" affordance, generate a code, then re-run with `--cli-signup-code rls_cli_...`. Note: this creates a brand-new account, not an agent key for your existing account. To connect an agent to your existing account, use Connect Agent -> generate an agent API key -> `rly auth login`.

**`CLI_SIGNUP_CODE_INVALID`** — The CLI signup code is expired or already used. Codes are valid for 30 minutes and are single-use. Generate a fresh one from the dashboard.

**`Error: This endpoint requires an admin API key or dashboard session`** — You're using an agent-scoped key for an admin operation. Use an admin key or the dashboard.

**`Error: Daily send limit reached`** — Sandbox (trust-level-0) accounts have a 15 email/day limit. Check your remaining budget and reset time with `rly account quota`, or upgrade your tier.

## Exit codes

The exit-code table below is the **canonical exit-code contract** the CLI follows — it is the contract enforced in code.

| Exit | Meaning |
|------|---------|
| `0` | Command succeeded — **including a `send`/`draft send` whose message was created but the scanner returned `status: blocked`, `quarantined`, or `pending_review`.** Read the JSON `status` field for the outcome. |
| `1` | Remote / API / runtime failure, **including every gate-reject** that prevented the message from being created — `RATE_LIMITED`, `REPLY_LOOP_DETECTED`, `RECIPIENT_NOT_ON_ALLOWLIST`, `RECIPIENT_UNDELIVERABLE`, the thread-mode `4xx` codes, `CONFIRM_REQUIRED`, and the `draft send` rejections `DRAFT_REJECTED_BY_RESCAN` / `DRAFT_ALREADY_SENT`. Discriminate on the JSON `code`, not the exit code. |
| `2` | Local usage / configuration error (bad flags, invalid local input — `VALIDATION_ERROR` / `INVALID_OPTION` / `UNKNOWN_OPTION`). |
| `3` | Authentication required / invalid. Auth failures exit `1` by default; set `REPLYLAYER_AUTH_EXIT_CODE=1` to get this distinct code instead (so scripts can tell auth failures apart from other API errors). |
| `4` | **`send`/`reply` with `--strict` only:** the message was blocked (terminal). Without `--strict` this is an exit `0` with `status: "blocked"`. |
| `5` | **`send`/`reply` with `--strict` only:** the message was held by an infrastructure error (retryable — retry the send). |
| `6` | **`send`/`reply` with `--strict` only:** the server returned an outcome the CLI did not recognize (fail-closed). |
| `130` | `USER_ABORTED` — an interactive confirmation was cancelled. |

**Agents:** key on the JSON `status` field for the scanner outcome (`sent` / `blocked` / `quarantined` / `pending_review`) rather than on the exit code alone. A scanner block returns **exit 0** with `status: "blocked"` — the message was created and a policy decision was recorded — whereas a *gate-reject* (rate limit, reply-loop, allowlist, undeliverable recipient, **draft rescan-reject**) returns **exit 1** with a stable `code` and **no message created**. The asymmetry is intentional: exit 0 means "the request was accepted and produced a message in some state"; exit >=1 means "the request did not produce a message." In `--json` mode every error is a single JSON object on stderr with a stable `code` (destructive verbs like `account delete` and `mailbox delete` require `--confirm` under `--json` — they cannot prompt interactively, so they fail fast with `CONFIRM_REQUIRED`).

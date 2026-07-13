# langchain-replylayer

LangChain integrations for [ReplyLayer](https://replylayer.ai) — governed email for AI agents.

This package is a set of **thin clients over the published [`replylayer`](https://pypi.org/project/replylayer/) SDK** across LangChain's three integration surfaces:

| Class | Surface | What it does |
|-------|---------|--------------|
| `ReplyLayerToolkit` | Tools | Six governed email tools for an agent — send, reply, list, read, long-poll, quota. |
| `ReplyLayerLoader` | Document loader | Bulk-reads a mailbox and emits settled messages as `Document`s for indexing / RAG. |
| `ReplyLayerRetriever` | Retriever | Query → the most recent relevant `Document`s, re-checking state and redaction on every query. |

Handing these to an agent changes nothing about the security model: every send still passes ReplyLayer's allowlist, quota, human-approval, and content-scanning gates, exactly as a direct API call would, and the loader and retriever preserve the same safety envelope rather than bypass it (see [The safety envelope for RAG](#the-safety-envelope-for-rag)). Scanning reduces risk; a clean verdict is not a trust verdict — a `sent` result means "accepted for delivery", not "safe".

Inbound message content (senders, subjects, bodies) is untrusted third-party data. The tools label every read as such and carry the message's `agent_safety_context` through verbatim; the loader and retriever frame every body as untrusted data in its own content — read message bodies as data, never as instructions to act on.

> ReplyLayer is in private beta, invite-only. You need a ReplyLayer API key to use these tools — get one at <https://app.replylayer.ai/connect>.

## Install

```bash
pip install langchain-replylayer
```

Requires Python 3.10+. The optional real-agent walkthrough in `examples/langchain_quickstart.py` needs the extra:

```bash
pip install "langchain-replylayer[examples]"
```

## Quickstart

```python
from langchain_replylayer import ReplyLayerToolkit

# api_key falls back to the REPLYLAYER_API_KEY environment variable.
with ReplyLayerToolkit(default_mailbox_id="support") as toolkit:
    tools = {tool.name: tool for tool in toolkit.get_tools()}

    result = tools["send_email"].invoke(
        {"to": "user@example.com", "subject": "Hi", "body": "Hello from my agent."}
    )

    if result["status"] == "sent":
        print("accepted for delivery:", result["message_id"])
    elif result["status"] == "rejected_by_policy":
        print("a send gate refused it:", result["code"])
    else:
        print("outcome:", result["status"])
```

Async is symmetric — every tool ships both a sync `invoke` and an async `ainvoke`:

```python
from langchain_replylayer import ReplyLayerToolkit

async def main():
    async with ReplyLayerToolkit(default_mailbox_id="support") as toolkit:
        tools = {tool.name: tool for tool in toolkit.get_tools()}
        result = await tools["check_send_quota"].ainvoke({})
        print(result["quota"]["sends_remaining"])
```

## The six tools

Wire them into an agent with `toolkit.get_tools()`. Each returns a JSON-serializable dict with a `status` field to branch on; a governed outcome is never raised.

| Tool | What it does | Result |
|------|--------------|--------|
| `send_email` | Send a new outbound email from a mailbox. | `{status, message_id?}` — `status` is one of `sent`, `rejected_by_policy`, `rejected`, `held_for_human_review`, `retry_later`, `rate_limited`, `error`. |
| `reply_to_email` | Reply to an inbound message, continuing its thread. | Same `status` set as `send_email`. |
| `list_messages` | List recent messages (cursor-paginated). | `{status: "ok", messages: [...], has_more, cursor, untrusted_content: true}`. Each row carries `id`, `sender`, `subject`, `state`, `created_at`. |
| `read_message` | Read one message in full. | `{status: "ok", id, sender, subject, state, created_at, body, body_format, body_truncated, agent_safety_context, untrusted_content: true}` — or `{status: "not_found", recheck: false}`. |
| `wait_for_message` | Long-poll a mailbox for the next message (≤30s). | `{status: "ok", message, untrusted_content: true}` — `message` is a compact row or `null` if none arrived. |
| `check_send_quota` | Preflight the remaining daily send budget. | `{status: "ok", quota}` — `quota.sends_remaining`, `quota.reset_at`, and `quota.today.limit`. |

Not exposed on purpose: anything that loosens containment (allowlist mutations, quarantine release, review approve/deny). The server rejects agent keys on those anyway, so the toolkit does not tempt a model with tools that would only 403.

## Index your inbox (document loader)

`ReplyLayerLoader` reads a mailbox and emits each settled message as a `Document`. It is a standard LangChain `BaseLoader` — `lazy_load()`, `load()`, `alazy_load()`, and `aload()` all work — and it is truly lazy, making no HTTP call until you iterate.

```python
from langchain_replylayer import ReplyLayerLoader

with ReplyLayerLoader(
    "support@yourco.example",
    direction="inbound",
    since="2026-07-01T00:00:00Z",
    max_messages=500,
) as loader:
    documents = loader.load()
```

Each `Document` carries the message id (`doc.id`), a `page_content` opening with a provenance header that frames the body as untrusted data, and flat metadata: `source`, `message_id`, `mailbox_id`, `thread_id`, `direction`, `state`, `sender`, `recipient`, `subject`, `created_at`, `scan_verdict`, `untrusted_content`, `body_truncated`, `char_count`, `returned_char_count`, and `has_attachments`. Emission is grouped by state, newest-first within each group; each unique message costs one audited read and no `Document.id` repeats within a run.

Constructor: `ReplyLayerLoader(mailbox_id, *, api_key=None, base_url=..., direction=None, since=None, until=None, unread=None, max_messages=None, include_provenance_header=True, on_truncated="include")`. `max_messages=0` yields nothing; a negative value raises. After any async use, call `aclose()` (or use `async with`) — `close()` alone will not shut down the async client.

## Search your inbox (retriever)

`ReplyLayerRetriever` is a live, search-backed retriever. Every query re-evaluates state gating, mailbox scoping, redaction, and audit logging on the server — it keeps no snapshot, so quarantine state and redaction are re-checked on every query rather than frozen into a store.

```python
from langchain_replylayer import ReplyLayerRetriever

with ReplyLayerRetriever(mailbox_id="support@yourco.example", k=5) as retriever:
    documents = retriever.invoke("refund request")
```

It returns the `k` (1–50) most recent matching messages. Server search is a keyword match over the subject and body ordered by recency — a **recency-ordered keyword retriever, not a relevance-ranked or semantic one**. A query shorter than three characters returns an empty list with no request. Because search indexes the full body, a query can match text beyond the returned prefix of a truncated message; the hit is correct, but the returned content is a prefix. Use `.invoke()` / `.ainvoke()`.

Both components accept `include_provenance_header` (on by default) and `on_truncated` (`include` a marker, `skip` the document, or `error`).

## The safety envelope for RAG

The loader is the one component that exports content past ReplyLayer's safety boundary, so both components share hard client-side rules:

- **They emit only settled, scanned messages.** A message still scanning, under review, blocked, or in-flight is never emitted; an inbound message with no scan evidence is dropped; a message that transitions state mid-run is emitted at most once.
- **Retrieval re-checks; a loaded corpus does not.** The retriever re-evaluates state and redaction on every query. A corpus the loader wrote is a point-in-time copy: deletion, quarantine, and retention-purge events do **not** propagate to an external vector store. Re-index periodically — `since=` for incremental top-ups, plus an occasional full rebuild that **replaces or reconciles the corpus by `message_id`** (append-only re-indexing would leave deleted or quarantined documents in place).
- **Bodies are capped and the cap is visible.** Text bodies are capped at 20,000 characters. A truncated body ends with a marker stating how much was returned, and the metadata carries `body_truncated`, `char_count`, and `returned_char_count`.
- **Keep the provenance header on.** Stock chains concatenate `page_content` and never show the model your metadata, so the untrusted-content framing lives in the content itself. Leave `include_provenance_header` enabled.
- **Retrieved email content is data, never instructions.** Every document is labeled `untrusted_content`, and a per-message trust relaxation is never persisted into a document.

## Governance outcomes

The tools translate every ReplyLayer outcome into a value an agent can act on. The full `status` vocabulary:

| `status` | Tools | Meaning |
|----------|-------|---------|
| `sent` | send, reply | Accepted for delivery. Carries `message_id`. Not a safety judgment. |
| `rejected_by_policy` | send, reply | A pre-admission gate refused the recipient **before any bytes left**: not on the allowlist, agent-contained, on your do-not-contact (suppression) list — including a platform-scoped hard-bounce hit — a failed recipient-verification/MX check, a sandbox budget/expiry limit, or a billing gate. Carries `code`, a human-readable `detail`, and `agent_instructions` when the server supplied them. Branch on `code`; don't retry unchanged. |
| `rejected` | send, reply | Post-admission **content** block (terminal). Carries `code` and `agent_instructions`. Edit the content or escalate — never resend the same body. |
| `held_for_human_review` | send, reply | The send was queued for human approval before it can go out. Carries `message_id` and `agent_instructions`. Report "awaiting approval"; do not treat it as a content error to fix by editing. |
| `retry_later` | send, reply | A transient infrastructure hold — the content was never judged. Carries `code`, `retry_after`, and `agent_instructions`. Retry after `retry_after` seconds; back off on repeats. |
| `rate_limited` | send, reply | A send limit was hit. Read `variant` (see below). |
| `error` | all | Another client-side problem the agent can see but that is not a governed policy outcome. Carries `code` and `details`. No retry is implied — fix the inputs. |
| `not_found` | read | The message id is unknown or not visible to this key. `recheck: false` — the wire cannot distinguish "not yet available" from "wrong id", so any recheck loop belongs to your workflow. |
| `ok` | list, read, wait, quota | The read succeeded; the payload follows. |

`rate_limited` carries a `variant` so the agent knows which limit it hit:

| `variant` | Fields | Meaning |
|-----------|--------|---------|
| `daily_budget` | `daily_limit`, `sends_remaining`, `reset_at` | The daily send budget is exhausted. Wait until `reset_at`. |
| `new_account_warmup` | `retry_after_seconds` | A new paid account's warm-up throttle. |
| `short_window` | `retry_after` | A generic short-window throttle. `retry_after` may be `null` when the server sent no hint. |

## Error policy — what each tool returns vs raises

The mapping mirrors where the server enforces each gate. A refusal an agent can act on comes back as a dict; a caller-misconfiguration or infrastructure fault is raised.

| Tool | Returned as a governed dict (never raised) | Raised |
|------|--------------------------------------------|--------|
| `send_email`, `reply_to_email` | `rejected_by_policy` (the enumerated send-gate codes), `rejected`, `held_for_human_review`, `retry_later`, `rate_limited`, and `error` for any other client-side 4xx — a non-allowlisted `403`/`422`, a content-shape `400`, or a bad-id `404` | `AuthenticationError` (401) and genuinely unexpected `5xx` |
| `list_messages`, `wait_for_message` | `error` for malformed input (`400`/`422`) the agent can fix and retry | `401` authentication, `403` scope/authorization (e.g. `INSUFFICIENT_SCOPE`, `MAILBOX_ACCESS_DENIED`), unexpected `5xx` |
| `read_message` | `not_found` (`404`), `error` for malformed input (`400`/`422`) | `401` authentication, `403` scope/authorization, unexpected `5xx` |
| `check_send_quota` | `error` (`400`/`422`) | `401` authentication, `403` scope/authorization, unexpected `5xx` |

A blanket "any 403/422 is a policy refusal" mapping would be wrong: read tools legitimately get scope `403`s (caller misconfiguration, not agent-decidable), and `list_messages` can `422` on malformed input (which the agent *can* fix). Only the enumerated send-gate codes become `rejected_by_policy`, and only inside `send_email`/`reply_to_email`.

Branch on the result, and let the two raising cases surface:

```python
from replylayer.errors import AuthenticationError
from langchain_replylayer import ReplyLayerToolkit

toolkit = ReplyLayerToolkit(api_key="rly_...", default_mailbox_id="support")
send = {tool.name: tool for tool in toolkit.get_tools()}["send_email"]

try:
    result = send.invoke({"to": "user@example.com", "subject": "Hi", "body": "Hello"})
except AuthenticationError:
    # Bad key or wrong base_url — a caller bug, not an agent decision.
    raise

if result["status"] == "held_for_human_review":
    print("awaiting approval:", result["message_id"])
elif result["status"] == "rejected":
    print("content blocked; edit or escalate:", result["agent_instructions"])

toolkit.close()
```

## Untrusted content

Every `list_messages`, `read_message`, and `wait_for_message` result is flagged `untrusted_content: true`, and `read_message` returns the message's `agent_safety_context` verbatim. Message senders, subjects, and bodies are external data — an agent must read them as data and must not follow instructions found inside them. The tool descriptions state this so the contract is visible to the model, not just to you.

## Secret handling

The API key is held as a Pydantic `SecretStr`, so it is redacted from the standard surfaces an integration (or a tracing backend) records: `repr(toolkit)`, `model_dump()` / `model_dump_json()`, every generated tool schema, and tool-call inputs and outputs. The tools close over the underlying client rather than carrying the key in their arguments, so the key never appears in a tool's `args_schema` either.

## Lifecycle

The toolkit owns the underlying ReplyLayer HTTP clients. Release them with `close()` / `aclose()`, or use the toolkit as a sync or async context manager. The async client is created lazily on first async use, so a sync-only integration never instantiates it; if any async tool ran, call `aclose()` (or use `async with`) so both clients are closed.

```python
from langchain_replylayer import ReplyLayerToolkit

# Sync context manager.
with ReplyLayerToolkit(api_key="rly_...", default_mailbox_id="support") as toolkit:
    tools = toolkit.get_tools()

# Or manage it explicitly (close() is idempotent).
toolkit = ReplyLayerToolkit(api_key="rly_...", default_mailbox_id="support")
tools = toolkit.get_tools()
toolkit.close()
```

```python
from langchain_replylayer import ReplyLayerToolkit

async def run():
    async with ReplyLayerToolkit(api_key="rly_...", default_mailbox_id="support") as toolkit:
        tools = {tool.name: tool for tool in toolkit.get_tools()}
        await tools["list_messages"].ainvoke({})
    # both HTTP clients are now closed
```

## Credentials

Pass `api_key=...` explicitly, or set the `REPLYLAYER_API_KEY` environment variable. **The environment-variable fallback is an adapter convenience** — the underlying `replylayer` SDK requires `api_key` explicitly; this adapter resolves the env var itself and passes it through. `base_url` defaults to the production API (`https://api.replylayer.ai`); set it to your staging API for verification runs. `default_mailbox_id` is the mailbox the tools use when a call does not name one.

Use a **mailbox-bound agent key** with an agent, not an admin key — the tools deliberately expose only read/act verbs, and an agent key keeps the containment boundary intact.

## Versioning

`langchain-replylayer` is versioned **independently of the `replylayer` SDK**. It is **not** part of the TypeScript↔Python method-mirror contract — that contract covers the resource SDKs, and this adapter is exempt. The `__all__` list in `langchain_replylayer/__init__.py` is the version-contracted public API — `ReplyLayerToolkit`, `ReplyLayerLoader`, `ReplyLayerRetriever`, and `__version__`; everything else (the `tools`, `toolkit`, `loader`, `retriever`, and underscore-prefixed modules) is private and may change between releases.

## Learn more

Full ReplyLayer documentation, including the API reference and the security model: <https://replylayer.ai/docs>.

## License

MIT

# Repeatable email workflows

These examples use a mailbox-bound agent key from the ReplyLayer dashboard,
after email and phone verification. Public beta access does not imply that
code-free CLI signup is enabled. Keep admin credentials outside the agent.

From this directory, install the adapter and the separately pinned example stack:

```bash
pip install 'langchain-replylayer>=0.2.2' -r requirements-workflows.txt
```

The six-tool adapter still supports `replylayer>=0.23.0`; optional workflow and
MCP dependencies are not installed by its runtime. CI exercises these pins
without a model, live account, or email delivery.

## Webhook ingress and LangGraph worker

`reply_workflow.py` supplies a signature-verifying ingress function and a
LangGraph worker that sends an operator-defined acknowledgment. It does not
start an HTTP server or provide a queue, scheduler, or checkpoint store.

Wire your HTTP handler's **unchanged raw request bytes** and
`X-ReplyLayer-Signature` header into `accept_webhook`, with the configured signing
secret, canonical mailbox UUID, and your durable queue's enqueue function.
Verify before parsing; do not reserialize JSON before checking the signature.
The existing combined signature remains valid alongside the Generic V2 headers.
Enforce a request-body size limit in your HTTP host.

The event selector is the envelope's `event` field. Authenticated events other
than `message.received`, and events for another mailbox, receive 200/ignored.
Only `event_id`, `mailbox_id`, and `message_id` reach the queue. Subjects, bodies,
and arbitrary payload fields never become prompt instructions or routing rules.
Invalid signatures receive 401, malformed received events 400, and enqueue
failures 503. An enqueue callback must commit durably before returning: 202
acknowledges queue acceptance, **not execution or successful email delivery**.
Alert on malformed validly signed events; ReplyLayer abandons non-429 4xx and
redirects immediately. Network failures, 429, and 5xx retry; repeated abandoned
deliveries can disable the webhook. Monitor disabled subscriptions too.

In your queue consumer (where `event` is the validated identifiers-only record):

```python
import os
from langchain_replylayer import ReplyLayerToolkit
from reply_workflow import build_reply_graph

with ReplyLayerToolkit(
    default_mailbox_id=os.environ["REPLYLAYER_MAILBOX_ID"],
) as toolkit:
    graph = build_reply_graph(
        toolkit,
        workflow_id="support-ack-v1",
        mailbox_id=os.environ["REPLYLAYER_MAILBOX_ID"],
        reply_body="Thanks. Your message has reached our support team.",
    )
    result = graph.invoke(event)
    # Persist result['completion'] and result['outcome'] in your queue/job store.
```

The worker reads the message and requires `available` before replying. It never
uses the inbound body as instructions. If you add a model, keep the identifier
trigger separate from email content, retain `agent_safety_context`, and explicitly
treat sender, subject, and body as untrusted data in the model's system prompt.

`reply_key` derives `rlh1:{workflow}:{mailbox_uuid}:{message_uuid}:reply` in code.
Use the same workflow slug and canonical IDs across webhook deliveries, cron
runs, crashes, and overlapping workers. Keys are account-wide and permanent;
send and reply share the namespace. Keep the action and workflow in the key.
Never generate a fresh key on retry or use a new workflow version to bypass an
existing rejection, hold, or indeterminate attempt. The API accepts arbitrary
non-empty trimmed strings; the example's slug restriction makes concatenation
unambiguous, rather than satisfying a server-side format requirement.

The server deduplicates outbound admissions by key. That is not a guarantee of
exactly-once inbox delivery, nor a replacement for your job ledger. Your consumer
must implement the following durable completion policy:

| `completion` | Consumer action |
| --- | --- |
| `accepted` | Record the outbound ID and stop submitting. `sent` means accepted for delivery; track delivery separately if needed. |
| `awaiting_human` | Record the hold and stop automatic sends; await the human outcome. |
| `blocked` | Record a terminal refusal and escalate as appropriate. |
| `retry_pending` | Schedule a bounded retry with the original key, respecting `retry_after` or budget reset. Bound missing/not-ready message rechecks too. |
| `needs_operator` | Pause automatic sends and surface the failure for reconciliation. |

`IDEMPOTENT_REQUEST_NOT_PROVEN_SENT` remains `status: error` and adds server
`detail` plus explicit `agent_instructions` in adapter 0.2.2. It does not promise
a message ID. An operator can inspect the SDK's `messages.get_idempotency_replay`
result, but it may only reconfirm `not_proven_sent` with no message. Reconciliation
may require a previously recorded outbound ID or operator delivery evidence; never
manufacture a new key to get past uncertainty. An in-flight same-key request remains retry-pending. Catch
raised transport/auth/scope errors in your consumer and apply bounded retry or
operator escalation; a crashed job is not complete. Persist terminal outcomes so
repeated webhook events do not restart paused work. Graph compilation alone
does not provide any of that persistence.

For a host without public ingress, a scheduled job can list inbound messages in
the configured mailbox, page through a persisted time window/cursor, and enqueue
the same identifier record (`event_id` may be the message UUID). Use the same
workflow slug and reply key. Persist job outcomes/checkpoints, overlap time windows
to recover interrupted scans, and never use unread state as the only ledger.

Webhook creation and optional static `request_headers` belong to operator setup,
not the toolkit. Header values are write-only; use SDK 0.27.0+ if configuring them
through the SDK. A receiver's extra authentication header does not replace raw-body
signature verification. Keep these values out of prompts and application logs.

## Hosted MCP alternative

`hosted_mcp.py` uses the pinned `langchain-mcp-adapters` API and MCP 1.x, explicitly
calls initialize, retains the server's workflow instructions, and loads only
`check_send_quota`. Set `REPLYLAYER_API_KEY` to a mailbox-bound agent key and run:

```bash
python hosted_mcp.py
```

It defaults to `https://api.replylayer.ai/mcp`; override `REPLYLAYER_MCP_URL` for
another environment. It performs a read-only quota call and no model invocation.
When extending it, pass the returned instructions into the agent's system context
and invoke the agent inside the open session. Do not assume tool conversion alone
surfaces initialization instructions. Native toolkit users must supply their own
workflow instructions; they do not receive the MCP handshake. MCP tool names and
error envelopes differ from the native six-tool adapter, so do not reuse its
`status` branching unchanged. For newer integrations, consult the current
[LangChain MCP documentation](https://docs.langchain.com/oss/python/langchain/mcp)
before changing the example pins.

Hosted MCP cannot read files from your machine: local attachment paths are
rejected on new hosted sends. Use the local stdio MCP server for local-file
attachments. A proven same-key replay is returned before the hosted attachment
guard; that does not authorize a new upload. The native six-tool toolkit does
not expose attachment inputs.

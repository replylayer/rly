"""Identifier-only webhook ingress and a deterministic LangGraph reply worker.

Install examples/requirements-workflows.txt. This module starts no HTTP server,
queue or model. Supply your application's durable queue and run the graph from
its worker; successful enqueue is NOT evidence that the graph or email completed.
The operator configures the fixed acknowledgement body, never the incoming email.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, TypedDict
from uuid import UUID

from replylayer import verify_webhook_signature
from replylayer.errors import WebhookSignatureError


class Event(TypedDict):
    event_id: str
    mailbox_id: str
    message_id: str


class State(Event, total=False):
    outcome: dict[str, Any]
    completion: str


def canonical_id(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Expected a UUID string")
    return str(UUID(value))


def reply_key(workflow_id: str, mailbox_id: str, message_id: str) -> str:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", workflow_id):
        raise ValueError("Set a stable workflow slug (lowercase letters, digits, hyphens)")
    # Same namespace as the ReplyLayer Hermes recipe: moving a workflow between
    # frameworks must not silently create a second send intent.
    return f"rlh1:{workflow_id}:{canonical_id(mailbox_id)}:{canonical_id(message_id)}:reply"


def accept_webhook(
    raw_body: bytes,
    signature: str,
    *,
    secret: str,
    mailbox_id: str,
    enqueue: Callable[[Event], None],
) -> tuple[int, dict[str, str]]:
    """Return an HTTP status/body; enqueue must commit durably before returning.

    Pass the unchanged body bytes and X-ReplyLayer-Signature header. The HTTP
    host must bound body size. Do not use an in-process background task as enqueue.
    All application/provider errors are hidden from the HTTP response.
    """
    expected_mailbox = canonical_id(mailbox_id)  # trusted configuration; validate at boot
    if not secret:
        raise ValueError("Configure the webhook signing secret before serving requests")
    try:
        verify_webhook_signature(raw_body, signature, secret)
    except (WebhookSignatureError, UnicodeError):
        return 401, {"status": "unauthorized"}
    try:
        envelope = json.loads(raw_body)
        if not isinstance(envelope, dict):
            raise ValueError("Expected object")
        # ReplyLayer uses 'event', not 'event_type'. Never template raw payloads.
        if envelope.get("event") != "message.received":
            return 200, {"status": "ignored"}
        data = envelope["data"]
        event = Event(
            event_id=canonical_id(envelope["id"]),
            mailbox_id=canonical_id(data["mailbox_id"]),
            message_id=canonical_id(data["message_id"]),
        )
    except (ValueError, KeyError, TypeError):
        return 400, {"status": "invalid_event"}
    if event["mailbox_id"] != expected_mailbox:
        return 200, {"status": "ignored"}
    try:
        enqueue(event)  # only IDs cross the boundary; no subject/body/sender
    except Exception:
        return 503, {"status": "queue_unavailable"}
    return 202, {"status": "queued"}


def completion_for(outcome: dict[str, Any]) -> str:
    code = outcome.get("code")
    if code == "IDEMPOTENT_REQUEST_NOT_PROVEN_SENT":
        return "needs_operator"
    if code == "IDEMPOTENT_REQUEST_IN_FLIGHT":
        return "retry_pending"
    return {
        "sent": "accepted",
        "held_for_human_review": "awaiting_human",
        "rejected": "blocked",
        "rejected_by_policy": "blocked",
        "retry_later": "retry_pending",
        "rate_limited": "retry_pending",
    }.get(outcome.get("status", ""), "needs_operator")


def build_reply_graph(toolkit: Any, *, workflow_id: str, mailbox_id: str, reply_body: str):
    """One operator-approved fixed reply per inbound message, using six-tool API.

    The caller owns toolkit lifetime. Persist the returned completion/outcome in
    the queue's job record; use bounded retries with the same identifiers. No LLM
    receives webhook text or chooses the idempotency key in this example.
    """
    from langgraph.graph import END, START, StateGraph

    expected_mailbox = canonical_id(mailbox_id)
    reply_key(workflow_id, expected_mailbox, expected_mailbox)  # validate slug at startup
    tools = {tool.name: tool for tool in toolkit.get_tools()}

    def respond(state: State) -> dict[str, Any]:
        if canonical_id(state["mailbox_id"]) != expected_mailbox:
            raise ValueError("Unexpected mailbox in queued job")
        message_id = canonical_id(state["message_id"])
        read = tools["read_message"].invoke({"message_id": message_id})
        if read.get("status") != "ok" or read.get("state") != "available":
            # Missing/scanning/reviewed/blocked mail is not permission to reply.
            # The job owner bounds these rechecks and surfaces unresolved jobs.
            return {"completion": "retry_pending", "outcome": read}
        result = tools["reply_to_email"].invoke({
            "message_id": message_id,
            "body": reply_body,
            "idempotency_key": reply_key(workflow_id, expected_mailbox, message_id),
        })
        return {"completion": completion_for(result), "outcome": result}

    graph = StateGraph(State)
    graph.add_node("respond", respond)
    graph.add_edge(START, "respond")
    graph.add_edge("respond", END)
    return graph.compile()

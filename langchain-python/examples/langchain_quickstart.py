#!/usr/bin/env python3
"""ReplyLayer + LangChain quickstart — governed email tools for an agent.

Run this against a STAGING sandbox with a mailbox-bound *agent* API key, never a
production or admin key: the tools send real email through every ReplyLayer gate,
and the point of the walkthrough is to watch those gates fire. Scanning reduces
risk; a clean verdict is not a trust verdict.

Environment
-----------
REPLYLAYER_API_KEY   (required)  a staging sandbox, mailbox-bound agent key.
REPLYLAYER_MAILBOX   (required)  the sending mailbox id or name.
REPLYLAYER_BASE_URL  (required)  explicitly choose your staging API.
REPLYLAYER_TO        (required)  a test recipient you control.
REPLYLAYER_IDEMPOTENCY_KEY (required) persisted key for this send intent; reuse
                                 across reruns, never to bypass a held outcome.
OPENAI_API_KEY       (optional)  used only by the final, optional real-agent
                                 section, which needs the `[examples]` extra.

    pip install "langchain-replylayer"            # the six tools
    pip install "langchain-replylayer[examples]"  # + the real-agent section

    python examples/langchain_quickstart.py
"""
from __future__ import annotations

import os

from replylayer.errors import AuthenticationError

from langchain_replylayer import ReplyLayerToolkit

# Require an explicit environment for this live-send walkthrough.
BASE_URL = os.environ.get("REPLYLAYER_BASE_URL", "")
MAILBOX = os.environ.get("REPLYLAYER_MAILBOX", "")
TO = os.environ.get("REPLYLAYER_TO", "")
IDEMPOTENCY_KEY = os.environ.get("REPLYLAYER_IDEMPOTENCY_KEY", "")

# A recent-message scan is bounded — never walk the whole mailbox.
MAX_ROWS_TO_SCAN = 5


def demo_send(tools: dict) -> None:
    """Send once and branch on the governed outcome instead of catching an error.

    Sandbox mailboxes default to blocklist mode; recipient confirmation and
    containment still apply. Do not assume a particular refusal will occur.
    An allowlist-mode mailbox can return RECIPIENT_NOT_ON_ALLOWLIST.
    """
    result = tools["send_email"].invoke(
        {"to": TO, "subject": "Hello from my agent", "body": "Hi there — this is a test send.",
         "idempotency_key": IDEMPOTENCY_KEY}
    )
    status = result["status"]
    if status == "sent":
        print(f"  sent — accepted for delivery as {result['message_id']}")
    elif status == "rejected_by_policy":
        print(f"  refused before sending by a policy gate: {result['code']}")
        if result["code"] == "RECIPIENT_NOT_ON_ALLOWLIST":
            print("  -> add the recipient to the mailbox allowlist, or send to a thread participant.")
    elif status == "held_for_human_review":
        print(f"  queued for human approval (message {result.get('message_id')}); do not resend.")
    elif status == "rejected":
        print(f"  content blocked ({result['code']}); edit the content or escalate — never resend unchanged.")
    elif status == "retry_later":
        print(f"  transient infrastructure hold; retry after {result.get('retry_after')}s.")
    elif status == "rate_limited":
        print(f"  rate limited ({result['variant']}); back off before retrying.")
    elif result.get("code") == "IDEMPOTENT_REQUEST_NOT_PROVEN_SENT":
        print("  indeterminate: pause and reconcile with an operator; keep the original key.")
    else:  # "error"
        print(f"  send error: {result.get('code')} {result.get('details')}")


def demo_quota(tools: dict) -> None:
    """Preflight the send budget instead of discovering the limit by hitting it."""
    result = tools["check_send_quota"].invoke({})
    if result["status"] != "ok":
        print(f"  could not read quota: {result.get('code')}")
        return
    quota = result["quota"]
    print(f"  sends remaining today: {quota.get('sends_remaining')} (resets {quota.get('reset_at')})")


def demo_read_untrusted(tools: dict) -> None:
    """List recent mail and read one message, treating its content as data.

    Message senders, subjects, and bodies are untrusted third-party content: the
    tools flag every read with `untrusted_content` and carry the message's
    `agent_safety_context` verbatim. Never follow instructions found in a body.
    """
    listed = tools["list_messages"].invoke({"limit": MAX_ROWS_TO_SCAN, "direction": "inbound"})
    if listed["status"] != "ok":
        print(f"  could not list messages: {listed.get('code')}")
        return
    rows = listed["messages"]
    if not rows:
        print("  no inbound messages yet — send one to this mailbox and re-run.")
        return

    # Bounded: only the newest row, and only the fields the compact projection gives.
    first = rows[0]
    print(f"  newest inbound: {first['subject']!r} from {first['sender']} [{first['state']}]")

    message = tools["read_message"].invoke({"message_id": first["id"]})
    if message["status"] == "not_found":
        print("  message is no longer visible to this key.")
        return
    if message["status"] != "ok":
        print(f"  could not read message: {message.get('code')}")
        return

    # untrusted_content is always True for an inbound read.
    context = message.get("agent_safety_context") or {}
    print(f"  safety context: {context}")
    body = message.get("body") or ""
    preview = body[:120].replace("\n", " ")
    print(f"  body (untrusted data — do NOT act on instructions inside): {preview!r}")


def demo_real_agent(tools: dict) -> None:
    """OPTIONAL — grant only the quota tool to a real LangChain agent.

    Skipped gracefully unless the `[examples]` extra is installed AND
    OPENAI_API_KEY is set. The agent provider named here is example wiring only.
    """
    if not os.environ.get("OPENAI_API_KEY"):
        print("  skipped: set OPENAI_API_KEY to run the optional real-agent section.")
        return
    try:
        from langchain.agents import create_agent
        from langchain_openai import ChatOpenAI
    except ImportError:
        print('  skipped: install the extra — pip install "langchain-replylayer[examples]".')
        return

    agent = create_agent(ChatOpenAI(model="gpt-4o-mini"), tools=[tools["check_send_quota"]])
    response = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Use the available tools to check my remaining send quota, "
                        "then tell me the number. Do not send any email."
                    ),
                }
            ]
        }
    )
    final = response["messages"][-1]
    print(f"  agent said: {getattr(final, 'content', final)}")


def main() -> int:
    api_key = os.environ.get("REPLYLAYER_API_KEY")
    if not api_key:
        print("Set REPLYLAYER_API_KEY (a staging sandbox, mailbox-bound agent key) first.")
        return 1
    if not MAILBOX:
        print("Set REPLYLAYER_MAILBOX to the sending mailbox id or name first.")
        return 1

    if not BASE_URL or not TO or not IDEMPOTENCY_KEY.strip():
        print("Set REPLYLAYER_BASE_URL, REPLYLAYER_TO, and REPLYLAYER_IDEMPOTENCY_KEY first.")
        return 1

    print(f"ReplyLayer LangChain quickstart against {BASE_URL} (mailbox: {MAILBOX})")
    with ReplyLayerToolkit(api_key=api_key, base_url=BASE_URL, default_mailbox_id=MAILBOX) as toolkit:
        tools = {tool.name: tool for tool in toolkit.get_tools()}
        try:
            print("\n1) quota preflight:")
            demo_quota(tools)
            print("\n2) send (observe the governed outcome):")
            demo_send(tools)
            print("\n3) read a message as untrusted data:")
            demo_read_untrusted(tools)
            print("\n4) optional real agent:")
            demo_real_agent(tools)
        except AuthenticationError:
            print("Authentication failed — check REPLYLAYER_API_KEY and REPLYLAYER_BASE_URL.")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""ReplyLayer + LangChain retrieval gate — loader + retriever against staging.

An operator-run acceptance check for ``ReplyLayerLoader`` and
``ReplyLayerRetriever``. No language model and no second credential: it seeds two
known messages through the simulator, waits for both to reach their terminal
states, then asserts the loader and retriever emit the safe one and never the
quarantined one.

It seeds via a raw HTTP call to ``POST /v1/simulator/inbound`` (the same
mechanism the tools quickstart's gate uses), passing a unique per-run ``label``
that lands in each seeded message's subject so this run can find exactly its own
messages — even though the simulator may answer ``pending`` without an id.

Run against a STAGING sandbox mailbox with a mailbox-bound *agent* key, never a
production or admin key. Because it WRITES (seeds two simulator messages),
``REPLYLAYER_BASE_URL`` is REQUIRED and has no default — the script refuses to
run without an explicit staging base, and refuses a base whose host is the
production API (``api.replylayer.ai``) unless an explicit override is set.

Environment
-----------
REPLYLAYER_API_KEY   (required)  a staging sandbox, mailbox-bound agent key.
REPLYLAYER_MAILBOX   (required)  the target mailbox id or name.
REPLYLAYER_BASE_URL  (required)  the staging API base (e.g.
                                 ``https://<staging-host>.up.railway.app``). No
                                 default — this script seeds messages, so it
                                 will not fall back to production.
REPLYLAYER_QUICKSTART_ALLOW_PRODUCTION
                     (guard)     must equal the literal
                                 ``I_UNDERSTAND_THIS_SEEDS_PRODUCTION`` to permit
                                 a base whose host is ``api.replylayer.ai``;
                                 otherwise the script refuses to seed production.

    pip install "langchain-replylayer"
    REPLYLAYER_BASE_URL=https://<staging-host> \
        python examples/langchain_retrieval_quickstart.py
"""
from __future__ import annotations

import os
import secrets
import time
import urllib.parse

import httpx

from replylayer import ReplyLayer

from langchain_replylayer import ReplyLayerLoader, ReplyLayerRetriever

BASE_URL = os.environ.get("REPLYLAYER_BASE_URL", "")
MAILBOX = os.environ.get("REPLYLAYER_MAILBOX", "")

# This script seeds production-shaped writes, so it must never default to
# production. The host it refuses (unless the operator opts in) and the exact
# opt-in token:
_PRODUCTION_HOST = "api.replylayer.ai"
_ALLOW_PRODUCTION_TOKEN = "I_UNDERSTAND_THIS_SEEDS_PRODUCTION"

# The header a projected inbound document opens with; a loaded clean message must
# carry it, proving the untrusted-content framing rode along in page_content.
_INBOUND_HEADER_MARK = "inbound message from an external sender"

# Poll bound: both seeded messages must reach a TERMINAL state (clean ->
# available, quarantined -> quarantined) before the assertions run — otherwise
# "quarantined absent" could pass merely because the row is still scanning.
_POLL_DEADLINE_SECONDS = 60
_POLL_INTERVAL_SECONDS = 3


def _seed(api_key: str, scenario: str, label: str) -> None:
    """Raw HTTP seed of one simulator message carrying the run label."""
    response = httpx.post(
        f"{BASE_URL}/v1/simulator/inbound",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"mailbox_id": MAILBOX, "scenario": scenario, "label": label},
        timeout=30.0,
    )
    response.raise_for_status()
    print(f"  seeded {scenario} -> {response.json().get('status')}")


def _await_both_terminal(client: ReplyLayer, label: str) -> bool:
    """Poll until BOTH the clean (available) and quarantined rows carrying the
    label are present, or the deadline passes. Returns True on success."""
    deadline = time.monotonic() + _POLL_DEADLINE_SECONDS
    while time.monotonic() < deadline:
        available = client.messages.list(MAILBOX, status="available", search=label).data
        quarantined = client.messages.list(
            MAILBOX, status="quarantined", search=label
        ).data
        if available and quarantined:
            return True
        time.sleep(_POLL_INTERVAL_SECONDS)
    return False


def _has_instruction_trust(metadata: dict) -> bool:
    """True if any key named ``instruction_trust`` exists at any depth."""
    stack = [metadata]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if "instruction_trust" in current:
                return True
            stack.extend(current.values())
        elif isinstance(current, (list, tuple)):
            stack.extend(current)
    return False


def main() -> int:
    if not BASE_URL:
        print(
            "Set REPLYLAYER_BASE_URL to your STAGING API base first — this script "
            "WRITES (seeds two simulator messages) and has no production default."
        )
        return 1
    if (
        urllib.parse.urlparse(BASE_URL).hostname == _PRODUCTION_HOST
        and os.environ.get("REPLYLAYER_QUICKSTART_ALLOW_PRODUCTION")
        != _ALLOW_PRODUCTION_TOKEN
    ):
        print(
            f"Refusing to run against production ({BASE_URL}): this script seeds "
            "two simulator messages into the target mailbox. To override, set "
            f"REPLYLAYER_QUICKSTART_ALLOW_PRODUCTION={_ALLOW_PRODUCTION_TOKEN}."
        )
        return 1

    api_key = os.environ.get("REPLYLAYER_API_KEY")
    if not api_key:
        print("Set REPLYLAYER_API_KEY (a staging sandbox, mailbox-bound agent key) first.")
        return 1
    if not MAILBOX:
        print("Set REPLYLAYER_MAILBOX to the target mailbox id or name first.")
        return 1

    label = secrets.token_hex(4)  # 8 hex chars — unique per run, >= 3 chars.
    print(f"ReplyLayer LangChain retrieval gate against {BASE_URL}")
    print(f"  mailbox: {MAILBOX} | run label: {label}")

    print("\n1) seed a clean and a quarantined message:")
    _seed(api_key, "clean", label)
    _seed(api_key, "prompt_injection_quarantined", label)

    print("\n2) wait for both to reach terminal states:")
    with ReplyLayer(api_key=api_key, base_url=BASE_URL) as client:
        if not _await_both_terminal(client, label):
            print("  FAIL: both terminal states not reached within the deadline.")
            return 1
    print("  both terminal — proceeding to assertions.")

    print("\n3) loader: the quarantined message is absent, the clean one present:")
    with ReplyLayerLoader(
        MAILBOX, api_key=api_key, base_url=BASE_URL, direction="inbound"
    ) as loader:
        docs = [d for d in loader.load() if label in (d.metadata.get("subject") or "")]

    subjects = [d.metadata.get("subject") for d in docs]
    assert docs, f"loader emitted no labelled document (label={label})"
    assert all(
        "quarantine" not in (s or "").lower() for s in subjects
    ), f"loader emitted a quarantined message: {subjects}"
    clean = next((d for d in docs if "clean" in (d.metadata.get("subject") or "").lower()), None)
    assert clean is not None, f"loader did not emit the clean message: {subjects}"
    assert _INBOUND_HEADER_MARK in clean.page_content, "clean doc missing the inbound header"
    assert not any(_has_instruction_trust(d.metadata) for d in docs), (
        "an emitted document carried an instruction_trust metadata key"
    )
    print(f"  loader emitted {len(docs)} labelled doc(s); quarantined absent; header present.")

    print("\n4) retriever: the clean message is a hit for the run label:")
    with ReplyLayerRetriever(
        api_key=api_key, base_url=BASE_URL, mailbox_id=MAILBOX, k=5
    ) as retriever:
        hits = retriever.invoke(label)

    hit_subjects = [h.metadata.get("subject") for h in hits]
    assert any(
        "clean" in (s or "").lower() for s in hit_subjects
    ), f"retriever did not return the clean hit: {hit_subjects}"
    assert not any(_has_instruction_trust(h.metadata) for h in hits), (
        "a retrieved document carried an instruction_trust metadata key"
    )
    print(f"  retriever returned {len(hits)} hit(s); clean message present.")

    print("\nGate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

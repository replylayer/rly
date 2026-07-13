"""Governance mapping — SDK outcomes to agent-branchable tool results.

Pure functions, no I/O. Each maps a ReplyLayer SDK response, or a raised
``replylayer.errors.ReplyLayerError``, into a JSON-serializable ``dict`` an
agent can branch on — or re-raises the faults an agent cannot act on
(authentication, unexpected 5xx).

Two enforcement layers, mirroring where the server enforces them:

* **Pre-admission policy refusals (send/reply only)** — an explicit allowlist of
  send-gate codes maps to ``rejected_by_policy``. The allowlist is send-tool-only
  and code-specific; a blanket ``403``/``422`` -> policy map would be wrong (read
  tools get scope ``403``s like ``INSUFFICIENT_SCOPE``, and ``list`` can reject
  malformed input — none of which are send policy).
* **Post-admission content outcomes** — the strict-outcome typed errors
  (``EmailEffect*``) and ``RateLimitError`` map to the governed send outcomes.

Scanning reduces risk; a clean verdict is not a trust verdict — the ``sent``
result means "accepted for delivery", not "safe".
"""
from __future__ import annotations

from typing import Any

from replylayer.errors import (
    AuthenticationError,
    EmailEffectHeldError,
    EmailEffectRejectedError,
    EmailEffectRetryableError,
    NotFoundError,
    RateLimitError,
    ReplyLayerError,
)

# Pre-admission send-gate codes that map to ``rejected_by_policy``. Extracted
# verbatim from https://replylayer.ai/agents/send-gates and
# https://replylayer.ai/agents/errors — every entry is a code the server can
# return *before any bytes leave* on a send/reply. Applied ONLY inside the
# send/reply tools; never on read/list/wait. This mirrors the plan's §1.4
# enumeration exactly — do not widen it without ratifying §1.4.
SEND_POLICY_CODES: frozenset[str] = frozenset(
    {
        # Recipient policy — send-gates.md §1-3; errors.md "Send gates —
        # recipient policy".
        "RECIPIENT_SUPPRESSED",
        "RECIPIENT_NOT_ON_ALLOWLIST",
        "RECIPIENT_AGENT_CONTAINED",
        # Recipient verification / MX — send-gates.md §5; errors.md same table.
        "RECIPIENT_ADDRESS_INVALID",
        "RECIPIENT_DOMAIN_TYPO_SUSPECTED",
        "RECIPIENT_ROLE_ADDRESS",
        "RECIPIENT_DISPOSABLE_ADDRESS",
        "RECIPIENT_UNDELIVERABLE",
        # Sandbox budget/state gates — send-gates.md §6; errors.md "Send
        # gates — mailbox, domain & account state".
        #
        # NOTE — FORBIDDEN is deliberately NOT here. The sandbox
        # unconfirmed-recipient gate returns a bare 403 FORBIDDEN
        # (send-gates.md §6), but FORBIDDEN is ALSO the generic "credential
        # valid but not permitted for this resource" authorization code
        # (errors.md:189, and the API-key-cap refusal). Plan §1.4's allowlist
        # does not enumerate it, and mapping it to ``rejected_by_policy`` would
        # mislabel a genuine credential/permission fault as a human-resolvable
        # policy refusal. Left OUT: a FORBIDDEN on a send/reply falls through to
        # the visible ``error`` mapping (§1.4: non-allowlisted 403 -> error).
        "SANDBOX_TRIAL_BUDGET_EXHAUSTED",
        "SANDBOX_TRIAL_EXPIRED",
        # Send-path billing gates — errors.md "Billing".
        "BILLING_LAPSED",
        "BILLING_REACTIVATION_PENDING",
        "PAYGO_INSUFFICIENT_CREDITS",
    }
)


def _agent_instructions_from_scan(scan: Any) -> list[str]:
    """Collect ``findings[].agent_instructions`` off a scan summary, de-duped
    and order-preserving. Structural — never parsed from prose."""
    instructions: list[str] = []
    if not isinstance(scan, dict):
        return instructions
    findings = scan.get("findings")
    if not isinstance(findings, list):
        return instructions
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        items = finding.get("agent_instructions")
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, str) and item not in instructions:
                instructions.append(item)
    return instructions


def _message_id_from_details(details: Any) -> str | None:
    """The strict-outcome error body carries ``message_id`` in ``details``."""
    if isinstance(details, dict):
        mid = details.get("message_id")
        if isinstance(mid, str):
            return mid
    return None


def _map_rate_limited(err: RateLimitError) -> dict[str, Any]:
    """The three canonical ``RATE_LIMITED`` variants (agents/errors.md).

    Discriminator: presence of ``details.daily_limit`` => daily budget; else
    ``details.reason == 'new_account_warmup'`` => warm-up; else a generic
    short-window throttle (``details.retry_after``, the ``Retry-After`` header,
    or nothing at all).
    """
    details = err.details if isinstance(err.details, dict) else {}
    result: dict[str, Any] = {"status": "rate_limited", "code": err.code}
    if "daily_limit" in details:
        result["variant"] = "daily_budget"
        result["daily_limit"] = details.get("daily_limit")
        result["sends_remaining"] = details.get("sends_remaining")
        result["reset_at"] = details.get("reset_at")
    elif details.get("reason") == "new_account_warmup":
        result["variant"] = "new_account_warmup"
        result["retry_after_seconds"] = details.get("retry_after_seconds")
    else:
        result["variant"] = "short_window"
        retry_after = details.get("retry_after")
        if retry_after is None:
            # Header-derived (RateLimitError parses Retry-After); may be None.
            retry_after = err.retry_after
        result["retry_after"] = retry_after
    return result


def _map_rejected_by_policy(err: ReplyLayerError) -> dict[str, Any]:
    """Pre-admission gate refusal -> ``{status, code, detail, agent_instructions?}``.

    ``detail`` is the human sentence (``str(err)``) for an operator; branch on
    ``code``. ``agent_instructions`` is included only when the server actually
    supplied a list of them in ``details``.
    """
    result: dict[str, Any] = {
        "status": "rejected_by_policy",
        "code": err.code,
        "detail": str(err),
    }
    if isinstance(err.details, dict):
        items = err.details.get("agent_instructions")
        if isinstance(items, list) and items and all(isinstance(i, str) for i in items):
            result["agent_instructions"] = list(items)
    return result


def map_send_success(response: dict[str, Any]) -> dict[str, Any]:
    """A 2xx send/reply body -> ``{status, message_id}``.

    Under strict outcomes a held/blocked send never resolves here (it raises an
    ``EmailEffect*`` error), so a success is a delivery-accepted ``sent``.
    """
    status = response.get("status")
    return {
        "status": status if isinstance(status, str) else "sent",
        "message_id": response.get("message_id"),
    }


def map_send_error(err: ReplyLayerError) -> dict[str, Any]:
    """Map an exception raised by ``send_email`` / ``reply_to_email``.

    Precedence — the strict-outcome typed subclasses first (so a 422/409/503
    that carries an ``email_effect`` marker is a governed outcome, not a bare
    validation error), then rate limits, then the policy allowlist, then any
    remaining client-side 4xx as a visible ``error`` dict. Authentication
    failures and 5xx faults re-raise.
    """
    if isinstance(err, EmailEffectRejectedError):
        return {
            "status": "rejected",
            "code": err.code,
            "agent_instructions": _agent_instructions_from_scan(err.scan),
        }
    if isinstance(err, EmailEffectHeldError):
        return {
            "status": "held_for_human_review",
            "message_id": _message_id_from_details(err.details),
            "agent_instructions": _agent_instructions_from_scan(err.scan),
        }
    if isinstance(err, EmailEffectRetryableError):
        return {
            "status": "retry_later",
            "code": err.code,
            "retry_after": err.retry_after,
            "agent_instructions": _agent_instructions_from_scan(err.scan),
        }
    if isinstance(err, RateLimitError) and err.code == "RATE_LIMITED":
        # Gate on the CODE, not just the class: the SDK raises RateLimitError
        # for every non-scheduling 429, but not every 429 is a throttle.
        # REPLY_LOOP_DETECTED (429, "pause, don't auto-retry" per
        # agents/errors.md) must NOT read as a retryable rate limit — it falls
        # through to the visible ``error`` mapping below instead.
        return _map_rate_limited(err)
    if isinstance(err, AuthenticationError):
        raise err
    if err.code in SEND_POLICY_CODES:
        return _map_rejected_by_policy(err)
    # Any other client-side 4xx (non-allowlisted 403/422, a 400 content
    # rejection like OUTBOUND_HTML_ACTIVE_CONTENT_REJECTED, a 404 bad id, a
    # non-strict 409) is agent-visible but not a governed policy outcome —
    # surface it, do not raise. 5xx infra faults fall through to the raise.
    if 400 <= err.status_code < 500:
        return {"status": "error", "code": err.code, "details": err.details}
    raise err


def _map_input_error_or_raise(err: ReplyLayerError) -> dict[str, Any]:
    """Shared read/list/wait mapping: malformed input (400 schema — e.g.
    ``SEARCH_TERM_TOO_SHORT`` — or 422 semantic) is agent-fixable -> ``error``
    dict; everything else (401 auth, 403 scope, unexpected 5xx) is caller
    misconfiguration or an infra fault the agent cannot act on, so re-raise."""
    if err.status_code in (400, 422):
        return {"status": "error", "code": err.code, "details": err.details}
    raise err


def map_read_message_error(err: ReplyLayerError) -> dict[str, Any]:
    """``read_message`` mapping. A 404 is ``not_found`` with ``recheck: false``
    — the wire gives no way to tell "not yet available" from "wrong id", so the
    adapter claims nothing it cannot derive; any recheck loop belongs to the
    caller's workflow."""
    if isinstance(err, NotFoundError):
        return {"status": "not_found", "recheck": False}
    return _map_input_error_or_raise(err)


def map_read_error(err: ReplyLayerError) -> dict[str, Any]:
    """``list_messages`` / ``wait_for_message`` / ``check_send_quota`` mapping."""
    return _map_input_error_or_raise(err)

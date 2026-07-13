"""Governance mapping — one assertion per typed error and per policy code.

Constructs the SDK exceptions directly (no HTTP) with their verified
constructor signatures and asserts the agent-branchable dict the tools return.
"""
from __future__ import annotations

import pytest

from replylayer.errors import (
    AuthenticationError,
    EmailEffectHeldError,
    EmailEffectRejectedError,
    EmailEffectRetryableError,
    ForbiddenError,
    NotFoundError,
    RateLimitError,
    ReplyLayerError,
    ValidationError,
)

from langchain_replylayer._governance import (
    SEND_POLICY_CODES,
    map_read_error,
    map_read_message_error,
    map_send_error,
    map_send_success,
)


# --- success ---------------------------------------------------------------


def test_map_send_success_passes_status_and_message_id() -> None:
    assert map_send_success({"message_id": "m1", "status": "sent"}) == {
        "status": "sent",
        "message_id": "m1",
    }


def test_map_send_success_defaults_status_to_sent() -> None:
    assert map_send_success({"message_id": "m2"}) == {
        "status": "sent",
        "message_id": "m2",
    }


def test_map_send_success_keeps_non_sent_status() -> None:
    assert map_send_success({"message_id": "m3", "status": "scheduled"})["status"] == "scheduled"


# --- post-admission content outcomes --------------------------------------


def test_rejected_collects_deduped_ordered_agent_instructions() -> None:
    scan = {
        "findings": [
            {"agent_instructions": ["Do not resend unchanged.", "Escalate to a human."]},
            {"agent_instructions": ["Do not resend unchanged."]},
        ]
    }
    err = EmailEffectRejectedError(
        "EMAIL_EFFECT_REJECTED",
        "content blocked",
        {"email_effect": {"effect_status": "blocked"}, "scan": scan, "message_id": "m"},
    )
    assert map_send_error(err) == {
        "status": "rejected",
        "code": "EMAIL_EFFECT_REJECTED",
        "agent_instructions": ["Do not resend unchanged.", "Escalate to a human."],
    }


def test_held_maps_message_id_from_details_and_scan_instructions() -> None:
    err = EmailEffectHeldError(
        "EMAIL_EFFECT_HELD",
        "queued for review",
        {
            "email_effect": {"effect_status": "held_for_review"},
            "scan": {"findings": [{"agent_instructions": ["Awaiting human approval."]}]},
            "message_id": "mid-123",
        },
    )
    assert map_send_error(err) == {
        "status": "held_for_human_review",
        "message_id": "mid-123",
        "agent_instructions": ["Awaiting human approval."],
    }


def test_retryable_maps_retry_after_from_headers_and_empty_instructions() -> None:
    err = EmailEffectRetryableError(
        "EMAIL_EFFECT_HELD_INFRA",
        "infra hold",
        {"retry-after": "12"},
        {"email_effect": {"effect_status": "held_infrastructure"}, "scan": None},
    )
    assert map_send_error(err) == {
        "status": "retry_later",
        "code": "EMAIL_EFFECT_HELD_INFRA",
        "retry_after": 12,
        "agent_instructions": [],
    }


# --- rate-limit variants ---------------------------------------------------


def test_rate_limited_daily_budget_variant() -> None:
    err = RateLimitError(
        "RATE_LIMITED",
        "daily limit",
        {},
        {"daily_limit": 100, "sends_remaining": 0, "reset_at": "2026-07-13T00:00:00Z"},
    )
    assert map_send_error(err) == {
        "status": "rate_limited",
        "code": "RATE_LIMITED",
        "variant": "daily_budget",
        "daily_limit": 100,
        "sends_remaining": 0,
        "reset_at": "2026-07-13T00:00:00Z",
    }


def test_rate_limited_new_account_warmup_variant() -> None:
    err = RateLimitError(
        "RATE_LIMITED",
        "warming up",
        {},
        {"reason": "new_account_warmup", "retry_after_seconds": 30},
    )
    assert map_send_error(err) == {
        "status": "rate_limited",
        "code": "RATE_LIMITED",
        "variant": "new_account_warmup",
        "retry_after_seconds": 30,
    }


def test_rate_limited_short_window_from_details() -> None:
    err = RateLimitError("RATE_LIMITED", "slow down", {}, {"retry_after": 5})
    assert map_send_error(err) == {
        "status": "rate_limited",
        "code": "RATE_LIMITED",
        "variant": "short_window",
        "retry_after": 5,
    }


def test_rate_limited_short_window_falls_back_to_retry_after_header() -> None:
    err = RateLimitError("RATE_LIMITED", "slow down", {"retry-after": "7"}, None)
    assert map_send_error(err)["retry_after"] == 7


def test_rate_limited_short_window_null_when_nothing_present() -> None:
    err = RateLimitError("RATE_LIMITED", "slow down", {}, None)
    assert map_send_error(err) == {
        "status": "rate_limited",
        "code": "RATE_LIMITED",
        "variant": "short_window",
        "retry_after": None,
    }


# --- pre-admission policy refusals -----------------------------------------

_POLICY_STATUS = {
    "RECIPIENT_ADDRESS_INVALID": 422,
    "RECIPIENT_DOMAIN_TYPO_SUSPECTED": 422,
    "RECIPIENT_ROLE_ADDRESS": 422,
    "RECIPIENT_DISPOSABLE_ADDRESS": 422,
    "RECIPIENT_UNDELIVERABLE": 422,
}


def _policy_error(code: str) -> ReplyLayerError:
    status = _POLICY_STATUS.get(code, 403)
    if status == 422:
        return ValidationError(422, code, f"{code} refusal")
    return ForbiddenError(code, f"{code} refusal")


@pytest.mark.parametrize("code", sorted(SEND_POLICY_CODES))
def test_every_send_policy_code_maps_to_rejected_by_policy(code: str) -> None:
    result = map_send_error(_policy_error(code))
    assert result["status"] == "rejected_by_policy"
    assert result["code"] == code
    assert isinstance(result["detail"], str) and result["detail"]


def test_policy_refusal_includes_agent_instructions_when_present() -> None:
    err = ForbiddenError(
        "RECIPIENT_NOT_ON_ALLOWLIST",
        "recipient not on allowlist",
        {"agent_instructions": ["Ask a human to add the recipient to the allowlist."]},
    )
    result = map_send_error(err)
    assert result["agent_instructions"] == [
        "Ask a human to add the recipient to the allowlist."
    ]


# --- non-policy client errors are visible but not raised -------------------


def test_bare_forbidden_is_error_not_policy() -> None:
    result = map_send_error(ForbiddenError("FORBIDDEN", "not permitted"))
    assert result == {"status": "error", "code": "FORBIDDEN", "details": None}


def test_content_shape_400_is_error() -> None:
    err = ValidationError(400, "OUTBOUND_HTML_ACTIVE_CONTENT_REJECTED", "active content")
    assert map_send_error(err)["status"] == "error"


def test_send_404_is_error() -> None:
    assert map_send_error(NotFoundError("BAD_ID", "no such id"))["status"] == "error"


# --- still raising ---------------------------------------------------------


def test_send_authentication_error_raises() -> None:
    with pytest.raises(AuthenticationError):
        map_send_error(AuthenticationError("UNAUTHORIZED", "bad key"))


def test_send_5xx_raises() -> None:
    with pytest.raises(ReplyLayerError):
        map_send_error(ReplyLayerError(500, "INTERNAL", "boom"))


# --- read/list/wait/quota mappings -----------------------------------------


def test_read_message_not_found_never_claims_recheck() -> None:
    assert map_read_message_error(NotFoundError("NOT_FOUND", "gone")) == {
        "status": "not_found",
        "recheck": False,
    }


def test_read_message_malformed_input_is_error() -> None:
    err = ValidationError(400, "SEARCH_TERM_TOO_SHORT", "too short", {"min_search_length": 3})
    result = map_read_message_error(err)
    assert result["status"] == "error"
    assert result["code"] == "SEARCH_TERM_TOO_SHORT"


def test_read_message_scope_403_raises() -> None:
    with pytest.raises(ForbiddenError):
        map_read_message_error(ForbiddenError("INSUFFICIENT_SCOPE", "no scope"))


def test_read_error_maps_422_to_error() -> None:
    assert map_read_error(ValidationError(422, "BAD_INPUT", "bad"))["status"] == "error"


def test_read_error_scope_403_raises() -> None:
    with pytest.raises(ForbiddenError):
        map_read_error(ForbiddenError("MAILBOX_ACCESS_DENIED", "denied"))


def test_read_error_5xx_raises() -> None:
    with pytest.raises(ReplyLayerError):
        map_read_error(ReplyLayerError(503, "UNAVAILABLE", "down"))


# ---------------------------------------------------------------------------
# Review-panel regressions
# ---------------------------------------------------------------------------


def test_reply_loop_detected_429_is_error_not_rate_limited():
    """REPLY_LOOP_DETECTED arrives as a 429 (so the SDK raises RateLimitError),
    but errors.md marks it "pause, don't auto-retry" — mapping it to the
    retryable ``rate_limited`` contract would instruct an agent to hammer the
    reply endpoint and re-arm the loop. It must surface as a visible ``error``."""
    err = RateLimitError("REPLY_LOOP_DETECTED", "reply loop guard tripped", headers={})
    result = map_send_error(err)
    assert result["status"] == "error"
    assert result["code"] == "REPLY_LOOP_DETECTED"
    assert result.get("variant") is None


def test_rate_limited_code_still_maps_to_rate_limited():
    """The code gate must not break the genuine throttle path."""
    err = RateLimitError("RATE_LIMITED", "slow down", headers={"retry-after": "5"})
    result = map_send_error(err)
    assert result["status"] == "rate_limited"
    assert result["variant"] == "short_window"

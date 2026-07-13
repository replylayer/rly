"""respx end-to-end tests for ``ReplyLayerRetriever`` — sync + async."""
from __future__ import annotations

from typing import Any

import httpx
import pytest
import respx

from replylayer.errors import RateLimitError

from langchain_replylayer import ReplyLayerRetriever

BASE = "https://api.test.local"
_LIST_URL = f"{BASE}/v1/mailboxes/mb1/messages"


def _retriever(**kwargs: Any) -> ReplyLayerRetriever:
    kwargs.setdefault("api_key", "test-key")
    kwargs.setdefault("base_url", BASE)
    kwargs.setdefault("mailbox_id", "mb1")
    return ReplyLayerRetriever(**kwargs)


def _list_row(
    id: str,
    *,
    created_at: str,
    direction: str = "outbound",
    state: str = "delivered",
    scan: Any = None,
) -> dict[str, Any]:
    if scan is None and direction == "inbound":
        scan = {"verdict": "clean"}
    return {
        "id": id,
        "direction": direction,
        "state": state,
        "sender": "s@example.com",
        "recipient": "r@example.com",
        "subject": f"subject {id}",
        "created_at": created_at,
        "scan": scan,
    }


def _detail(
    id: str,
    *,
    direction: str = "outbound",
    state: str = "delivered",
    scan: Any = "auto",
    truncated: bool = False,
) -> dict[str, Any]:
    if scan == "auto":
        scan = {"verdict": "clean"} if direction == "inbound" else None
    return {
        "id": id,
        "direction": direction,
        "state": state,
        "sender": "s@example.com",
        "recipient": "r@example.com",
        "subject": f"subject {id}",
        "created_at": "2026-07-12T10:00:00Z",
        "mailbox_id": "mb1",
        "thread_id": None,
        "body": {
            "format": "text",
            "content": "the body",
            "char_count": 20000 if truncated else 8,
            "returned_char_count": 8,
            "truncated": truncated,
        },
        "scan": scan,
        "agent_safety_context": (
            {"untrusted_content": True, "guidance": "data only"}
            if direction == "inbound"
            else None
        ),
        "attachments": [],
    }


def _mock_lists(
    *, available: list = None, delivered: list = None, bounced: list = None
) -> dict[str, respx.Route]:
    routes = {}
    for status, rows in (
        ("available", available or []),
        ("delivered", delivered or []),
        ("bounced", bounced or []),
    ):
        routes[status] = respx.get(
            _LIST_URL, params__contains={"status": status}
        ).mock(return_value=httpx.Response(200, json={"messages": rows}))
    return routes


# --- query guard -----------------------------------------------------------


@respx.mock
def test_short_query_returns_empty_with_zero_http() -> None:
    lists = _mock_lists()
    r = _retriever()
    assert r.invoke("ab") == []
    assert r.invoke("  a  ") == []
    assert not any(route.called for route in lists.values())
    r.close()


@respx.mock
def test_query_is_truncated_to_200_chars() -> None:
    lists = _mock_lists(available=[_list_row("x", created_at="t1")])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x"))
    )
    r = _retriever()
    r.invoke("q" * 250)
    sent = lists["available"].calls[0].request.url.params.get("search")
    assert len(sent) == 200
    r.close()


# --- three searches, merge + dedup (S1b) -----------------------------------


@respx.mock
def test_three_status_constrained_searches_are_issued() -> None:
    lists = _mock_lists()
    r = _retriever()
    r.invoke("hello")
    assert lists["available"].called
    assert lists["delivered"].called
    assert lists["bounced"].called
    r.close()


@respx.mock
def test_dedup_same_id_in_two_statuses_one_detail_one_doc() -> None:
    row_av = _list_row("x", created_at="2026-07-12T09:00:00Z", state="available")
    row_de = _list_row("x", created_at="2026-07-12T09:00:00Z", state="delivered")
    _mock_lists(available=[row_av], delivered=[row_de])
    detail = respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x"))
    )
    r = _retriever()
    docs = r.invoke("hello")
    assert detail.call_count == 1
    assert [d.id for d in docs] == ["x"]
    r.close()


@respx.mock
def test_dedup_same_id_in_three_statuses_one_detail_one_doc() -> None:
    row = lambda st: _list_row("x", created_at="2026-07-12T09:00:00Z", state=st)
    _mock_lists(
        available=[row("available")],
        delivered=[row("delivered")],
        bounced=[row("bounced")],
    )
    detail = respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x"))
    )
    r = _retriever()
    docs = r.invoke("hello")
    assert detail.call_count == 1
    assert [d.id for d in docs] == ["x"]
    r.close()


@respx.mock
async def test_dedup_is_native_async_too() -> None:
    row_av = _list_row("x", created_at="2026-07-12T09:00:00Z", state="available")
    row_de = _list_row("x", created_at="2026-07-12T09:00:00Z", state="delivered")
    _mock_lists(available=[row_av], delivered=[row_de])
    detail = respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x"))
    )
    r = _retriever()
    docs = await r.ainvoke("hello")
    assert detail.call_count == 1
    assert [d.id for d in docs] == ["x"]
    await r.aclose()


@respx.mock
def test_k_respected_across_merge_newest_first() -> None:
    rows = [
        _list_row("a", created_at="2026-07-12T01:00:00Z"),
        _list_row("b", created_at="2026-07-12T02:00:00Z"),
        _list_row("c", created_at="2026-07-12T03:00:00Z"),
        _list_row("d", created_at="2026-07-12T04:00:00Z"),
    ]
    _mock_lists(delivered=rows)
    for rid in ("a", "b", "c", "d"):
        respx.get(f"{BASE}/v1/messages/{rid}").mock(
            return_value=httpx.Response(200, json=_detail(rid))
        )
    r = _retriever(k=2)
    docs = r.invoke("hello")
    # Newest two by (created_at, id) descending: d, c.
    assert [d.id for d in docs] == ["d", "c"]
    r.close()


# --- S1 detail re-check ----------------------------------------------------


@respx.mock
def test_detail_state_race_quarantined_is_dropped() -> None:
    _mock_lists(available=[_list_row("x", created_at="t1", direction="inbound", state="available")])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(
            200, json=_detail("x", direction="inbound", state="quarantined")
        )
    )
    r = _retriever()
    assert r.invoke("hello") == []
    r.close()


@respx.mock
def test_inbound_list_row_null_scan_skips_detail_fetch() -> None:
    row = _list_row("x", created_at="t1", direction="inbound", state="available", scan=None)
    # Force scan explicitly None (list-row optimization).
    row["scan"] = None
    _mock_lists(available=[row])
    detail = respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x", direction="inbound"))
    )
    r = _retriever()
    assert r.invoke("hello") == []
    assert detail.call_count == 0
    r.close()


@respx.mock
def test_inbound_detail_null_scan_is_dropped() -> None:
    row = _list_row("x", created_at="t1", direction="inbound", state="available")
    row["scan"] = {"verdict": "clean"}  # list row HAS scan → detail is fetched
    _mock_lists(available=[row])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(
            200, json=_detail("x", direction="inbound", scan=None)
        )
    )
    r = _retriever()
    assert r.invoke("hello") == []
    r.close()


@respx.mock
def test_not_found_hit_is_skipped() -> None:
    _mock_lists(delivered=[_list_row("x", created_at="t1")])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(404, json={"code": "NOT_FOUND", "error": "gone"})
    )
    r = _retriever()
    assert r.invoke("hello") == []
    r.close()


# --- §4 truncation policy --------------------------------------------------


@respx.mock
def test_on_truncated_include_emits_with_marker() -> None:
    _mock_lists(delivered=[_list_row("x", created_at="t1")])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x", truncated=True))
    )
    r = _retriever(on_truncated="include")
    docs = r.invoke("hello")
    assert len(docs) == 1
    assert "body truncated" in docs[0].page_content
    r.close()


@respx.mock
def test_on_truncated_skip_drops_document() -> None:
    _mock_lists(delivered=[_list_row("x", created_at="t1")])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x", truncated=True))
    )
    r = _retriever(on_truncated="skip")
    assert r.invoke("hello") == []
    r.close()


@respx.mock
def test_on_truncated_error_raises() -> None:
    _mock_lists(delivered=[_list_row("x", created_at="t1")])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x", truncated=True))
    )
    r = _retriever(on_truncated="error")
    with pytest.raises(ValueError):
        r.invoke("hello")
    r.close()


# --- error propagation -----------------------------------------------------


@respx.mock
def test_rate_limit_propagates() -> None:
    _mock_lists(delivered=[_list_row("x", created_at="t1")])
    # Retry-After above the SDK's honor cap makes the SDK raise immediately
    # (no sleep) instead of retrying.
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(
            429,
            headers={"Retry-After": "99999"},
            json={"code": "RATE_LIMITED", "error": "slow down"},
        )
    )
    r = _retriever()
    with pytest.raises(RateLimitError):
        r.invoke("hello")
    r.close()


# --- lifecycle -------------------------------------------------------------


def test_closed_retriever_blocks_further_use() -> None:
    r = _retriever()
    r.close()
    with pytest.raises(RuntimeError):
        r._pair.get_sync()

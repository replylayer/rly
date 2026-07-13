"""respx tests for ``ReplyLayerLoader`` — sync ``lazy_load`` + native ``alazy_load``."""
from __future__ import annotations

import re
from typing import Any

import httpx
import pytest
import respx

from langchain_replylayer import ReplyLayerLoader

BASE = "https://api.test.local"
_LIST_URL = f"{BASE}/v1/mailboxes/mb1/messages"
_DETAIL_RE = re.escape(BASE) + r"/v1/messages/[^/]+$"


def _loader(**kwargs: Any) -> ReplyLayerLoader:
    kwargs.setdefault("api_key", "test-key")
    kwargs.setdefault("base_url", BASE)
    return ReplyLayerLoader("mb1", **kwargs)


def _row(
    id: str,
    *,
    direction: str = "outbound",
    state: str = "available",
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
        "created_at": "2026-07-12T10:00:00Z",
        "scan": scan,
    }


def _detail(
    id: str,
    *,
    direction: str = "outbound",
    state: str = "available",
    truncated: bool = False,
) -> dict[str, Any]:
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


def _mock_lists(*, available=None, delivered=None, bounced=None) -> dict[str, respx.Route]:
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


def _mock_details_generic(direction: str = "outbound", state: str = "available") -> respx.Route:
    def _se(request: httpx.Request) -> httpx.Response:
        mid = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json=_detail(mid, direction=direction, state=state))

    return respx.get(url__regex=_DETAIL_RE).mock(side_effect=_se)


# --- laziness --------------------------------------------------------------


@respx.mock
def test_no_http_before_iteration() -> None:
    lists = _mock_lists(available=[_row("x")])
    _mock_details_generic()
    loader = _loader()
    gen = loader.lazy_load()
    assert not any(r.called for r in lists.values())  # constructing the iterator is free
    next(gen)
    assert lists["available"].called
    loader.close()


# --- traversal composition + emission order --------------------------------


@respx.mock
def test_three_traversal_composition_grouped_order() -> None:
    _mock_lists(
        available=[_row("a1"), _row("a2")],
        delivered=[_row("d1", state="delivered")],
        bounced=[_row("b1", state="bounced")],
    )

    def _se(request: httpx.Request) -> httpx.Response:
        mid = request.url.path.rsplit("/", 1)[-1]
        state = {"a1": "available", "a2": "available", "d1": "delivered", "b1": "bounced"}[mid]
        return httpx.Response(200, json=_detail(mid, state=state))

    respx.get(url__regex=_DETAIL_RE).mock(side_effect=_se)
    docs = _loader().load()
    assert [d.id for d in docs] == ["a1", "a2", "d1", "b1"]


@respx.mock
def test_inbound_direction_runs_only_available_traversal() -> None:
    lists = _mock_lists(
        available=[_row("x", direction="inbound", state="available")],
        delivered=[_row("d", state="delivered")],
        bounced=[_row("b", state="bounced")],
    )
    _mock_details_generic(direction="inbound", state="available")
    docs = _loader(direction="inbound").load()
    assert [d.id for d in docs] == ["x"]
    assert lists["available"].called
    assert not lists["delivered"].called
    assert not lists["bounced"].called


# --- dedup (S1b) -----------------------------------------------------------


@respx.mock
def test_dedup_same_id_two_statuses_one_detail_one_doc() -> None:
    _mock_lists(
        available=[_row("x", state="available")],
        delivered=[_row("x", state="delivered")],
    )
    detail = respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x"))
    )
    docs = _loader().load()
    assert detail.call_count == 1
    assert [d.id for d in docs] == ["x"]


@respx.mock
def test_dedup_same_id_three_statuses_one_detail_one_doc() -> None:
    _mock_lists(
        available=[_row("x", state="available")],
        delivered=[_row("x", state="delivered")],
        bounced=[_row("x", state="bounced")],
    )
    detail = respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x"))
    )
    docs = _loader().load()
    assert detail.call_count == 1
    assert [d.id for d in docs] == ["x"]


@respx.mock
async def test_dedup_native_async() -> None:
    _mock_lists(
        available=[_row("x", state="available")],
        delivered=[_row("x", state="delivered")],
        bounced=[_row("x", state="bounced")],
    )
    detail = respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x"))
    )
    docs = [d async for d in _loader().alazy_load()]
    assert detail.call_count == 1
    assert [d.id for d in docs] == ["x"]


@respx.mock
async def test_dedup_native_async_two_statuses() -> None:
    _mock_lists(
        available=[_row("x", state="available")],
        delivered=[_row("x", state="delivered")],
    )
    detail = respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x"))
    )
    docs = [d async for d in _loader().alazy_load()]
    assert detail.call_count == 1
    assert [d.id for d in docs] == ["x"]


# --- pagination ------------------------------------------------------------


@respx.mock
def test_multi_page_pagination_within_a_status() -> None:
    # The SDK's cursor fires when a page is exactly `limit` (50) rows long.
    page1 = [_row(f"p{i}") for i in range(50)]
    page2 = [_row("p50"), _row("p51"), _row("p52")]

    def _list_se(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("status") != "available":
            return httpx.Response(200, json={"messages": []})
        before = request.url.params.get("before")
        return httpx.Response(200, json={"messages": page1 if before is None else page2})

    list_route = respx.get(_LIST_URL).mock(side_effect=_list_se)
    detail = _mock_details_generic()
    docs = _loader().load()
    assert len(docs) == 53
    assert detail.call_count == 53
    # available traversal fetched two pages (plus one empty page each for the
    # delivered + bounced traversals) = 4 list calls total.
    assert list_route.call_count == 4


# --- max_messages ----------------------------------------------------------


@respx.mock
def test_max_messages_caps_total() -> None:
    _mock_lists(available=[_row("a1"), _row("a2"), _row("a3")])
    _mock_details_generic()
    docs = _loader(max_messages=2).load()
    assert [d.id for d in docs] == ["a1", "a2"]


@respx.mock
def test_max_messages_zero_yields_nothing_with_no_http() -> None:
    lists = _mock_lists(available=[_row("a1")])
    _mock_details_generic()
    docs = _loader(max_messages=0).load()
    assert docs == []
    assert not any(r.called for r in lists.values())


def test_negative_max_messages_raises_at_construction() -> None:
    with pytest.raises(ValueError):
        _loader(max_messages=-1)


def test_invalid_on_truncated_raises_at_construction() -> None:
    # A typo like "skpi" must NOT silently degrade to the 'include' policy — it
    # is rejected at construction, before any HTTP (no respx mock is active).
    with pytest.raises(ValueError):
        _loader(on_truncated="skpi")


# --- filter passthrough ----------------------------------------------------


@respx.mock
def test_since_until_direction_unread_passthrough() -> None:
    lists = _mock_lists()
    _loader(
        direction="outbound",
        since="2026-01-01T00:00:00Z",
        until="2026-12-31T00:00:00Z",
        unread=True,
    ).load()
    params = lists["available"].calls[0].request.url.params
    assert params.get("since") == "2026-01-01T00:00:00Z"
    assert params.get("until") == "2026-12-31T00:00:00Z"
    assert params.get("direction") == "outbound"
    assert params.get("unread") == "true"


# --- truncation ------------------------------------------------------------


@respx.mock
def test_long_body_marker_on_include() -> None:
    _mock_lists(available=[_row("x")])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x", truncated=True))
    )
    docs = _loader(on_truncated="include").load()
    assert "body truncated" in docs[0].page_content


@respx.mock
def test_long_body_skip_drops_it() -> None:
    _mock_lists(available=[_row("x")])
    respx.get(f"{BASE}/v1/messages/x").mock(
        return_value=httpx.Response(200, json=_detail("x", truncated=True))
    )
    assert _loader(on_truncated="skip").load() == []


# --- lifecycle -------------------------------------------------------------


def test_closed_loader_blocks_further_use() -> None:
    loader = _loader()
    loader.close()
    with pytest.raises(RuntimeError):
        loader.load()


async def test_async_use_then_aclose() -> None:
    loader = _loader()

    @respx.mock
    async def _run() -> None:
        _mock_lists(available=[_row("x")])
        respx.get(f"{BASE}/v1/messages/x").mock(
            return_value=httpx.Response(200, json=_detail("x"))
        )
        docs = [d async for d in loader.alazy_load()]
        assert [d.id for d in docs] == ["x"]

    await _run()
    await loader.aclose()
    with pytest.raises(RuntimeError):
        loader._pair.get_async()

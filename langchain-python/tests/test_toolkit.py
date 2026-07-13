"""Toolkit construction, secret redaction, tool set, and lifecycle."""
from __future__ import annotations

import pytest

from langchain_replylayer import ReplyLayerToolkit

_SECRET = "rly_live_ZZTOPSECRETZZ.paddddddddddddddddddddddddddddddddddddddddddddd"

_EXPECTED_TOOL_NAMES = {
    "send_email",
    "reply_to_email",
    "list_messages",
    "read_message",
    "wait_for_message",
    "check_send_quota",
}


def _toolkit() -> ReplyLayerToolkit:
    return ReplyLayerToolkit(
        api_key=_SECRET, base_url="https://api.test.local", default_mailbox_id="support"
    )


# --- credential handling ---------------------------------------------------


def test_api_key_required_when_env_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("REPLYLAYER_API_KEY", raising=False)
    with pytest.raises(ValueError):
        ReplyLayerToolkit()


def test_env_var_is_an_adapter_convenience_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPLYLAYER_API_KEY", "env-supplied-key")
    toolkit = ReplyLayerToolkit()
    assert toolkit.api_key.get_secret_value() == "env-supplied-key"


def test_explicit_api_key_overrides_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPLYLAYER_API_KEY", "env-supplied-key")
    toolkit = ReplyLayerToolkit(api_key=_SECRET)
    assert toolkit.api_key.get_secret_value() == _SECRET


# --- secret redaction ------------------------------------------------------


def test_secret_absent_from_toolkit_repr_and_dump() -> None:
    toolkit = _toolkit()
    assert _SECRET not in repr(toolkit)
    assert _SECRET not in str(toolkit.model_dump())
    assert _SECRET not in str(toolkit.model_dump(mode="json"))
    assert _SECRET not in toolkit.model_dump_json()


def test_secret_absent_from_every_tool_surface() -> None:
    toolkit = _toolkit()
    for tool in toolkit.get_tools():
        assert _SECRET not in repr(tool)
        assert _SECRET not in (tool.description or "")
        assert _SECRET not in str(tool.args)
        assert _SECRET not in str(tool.args_schema.model_json_schema())


# --- tool set --------------------------------------------------------------


def test_get_tools_returns_the_six_named_tools() -> None:
    tools = _toolkit().get_tools()
    assert {tool.name for tool in tools} == _EXPECTED_TOOL_NAMES
    assert len(tools) == 6


def test_every_tool_has_sync_and_async_paths() -> None:
    for tool in _toolkit().get_tools():
        assert tool.func is not None
        assert tool.coroutine is not None


# --- lifecycle -------------------------------------------------------------


def test_sync_only_use_never_constructs_the_async_client() -> None:
    toolkit = _toolkit()
    toolkit._get_sync_client()
    assert toolkit._sync_client is not None
    assert toolkit._async_client is None


def test_close_is_idempotent_and_blocks_further_use() -> None:
    toolkit = _toolkit()
    toolkit._get_sync_client()
    toolkit.close()
    toolkit.close()
    with pytest.raises(RuntimeError):
        toolkit._get_sync_client()


def test_sync_context_manager_closes_client() -> None:
    with _toolkit() as toolkit:
        toolkit._get_sync_client()
    assert toolkit._sync_client is None
    assert toolkit._closed is True


async def test_aclose_is_idempotent_and_closes_both_clients() -> None:
    toolkit = _toolkit()
    toolkit._get_sync_client()
    toolkit._get_async_client()
    await toolkit.aclose()
    await toolkit.aclose()
    assert toolkit._sync_client is None
    assert toolkit._async_client is None


async def test_async_context_manager_closes_clients() -> None:
    async with _toolkit() as toolkit:
        toolkit._get_async_client()
    assert toolkit._async_client is None
    assert toolkit._closed is True


def test_secret_absent_from_invoked_tool_input_and_output(monkeypatch):
    """Plan §1.2 names tool-call inputs/outputs among the redaction surfaces:
    an invoked tool's argument dict and returned dict must not carry the key."""
    from langchain_replylayer import ReplyLayerToolkit

    secret = "rly_live_REDACTION_PROBE_9z8y7x"
    tk = ReplyLayerToolkit(api_key=secret)
    tool = next(t for t in tk.get_tools() if t.name == "check_send_quota")

    class _FakeAccount:
        def get_quota(self):
            return {"sends_remaining": 3, "reset_at": "t", "today": {"limit": 15}}

    class _FakeClient:
        account = _FakeAccount()

    monkeypatch.setattr(tk, "_get_sync_client", lambda: _FakeClient())
    tool = next(t for t in tk.get_tools() if t.name == "check_send_quota")
    args: dict = {}
    result = tool.invoke(args)
    assert secret not in str(args)
    assert secret not in str(result)
    tk.close()

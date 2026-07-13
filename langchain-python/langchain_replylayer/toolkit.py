"""``ReplyLayerToolkit`` — the public entry point.

A LangChain ``BaseToolkit`` that owns the underlying ReplyLayer HTTP clients and
hands out the six governed email tools via ``get_tools()``. The API key is held
as a Pydantic ``SecretStr`` so it is redacted from ``repr``, ``model_dump()``,
and every generated tool schema. The clients are constructed with
``strict_outcome=True`` so held/blocked sends surface as the typed
``EmailEffect*`` outcomes the tools map (without it the server never applies the
strict mapping).
"""
from __future__ import annotations

import os
from typing import Optional

from langchain_core.tools import BaseTool, BaseToolkit
from pydantic import ConfigDict, Field, PrivateAttr, SecretStr, model_validator

from replylayer import AsyncReplyLayer, ReplyLayer

from ._clients import _ClientPair
from .tools import build_tools

_DEFAULT_BASE_URL = "https://api.replylayer.ai"
_API_KEY_ENV_VAR = "REPLYLAYER_API_KEY"


class ReplyLayerToolkit(BaseToolkit):
    """LangChain toolkit exposing ReplyLayer's governed email tools.

    Construct with ``api_key`` (or set ``REPLYLAYER_API_KEY``), an optional
    ``base_url``, and an optional ``default_mailbox_id`` the tools fall back to
    when a call omits one. Call ``get_tools()`` for the six tools, then
    ``close()`` / ``aclose()`` (or use the toolkit as a context manager) to
    release the HTTP clients.

    Every tool is a thin wrapper over the published ``replylayer`` SDK, so each
    send still passes the allowlist, quota, human-approval, and content-scanning
    gates. Scanning reduces risk; a clean verdict is not a trust verdict.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    api_key: SecretStr = Field(
        default_factory=lambda: SecretStr(os.environ.get(_API_KEY_ENV_VAR, "")),
        description=(
            "ReplyLayer API key, held as a SecretStr so it is redacted from "
            "reprs, model_dump(), and tool schemas. As an adapter convenience "
            "it falls back to the REPLYLAYER_API_KEY environment variable when "
            "not passed explicitly."
        ),
    )
    base_url: str = Field(
        default=_DEFAULT_BASE_URL, description="ReplyLayer API base URL."
    )
    default_mailbox_id: Optional[str] = Field(
        default=None,
        description="Mailbox the tools use when a call does not name one.",
    )

    # The lazy sync+async client pair + its lifecycle live in the shared
    # _ClientPair helper. The toolkit exposes the pair's state read-only so the
    # existing surface (_sync_client / _async_client / _closed) is unchanged.
    _pair: _ClientPair = PrivateAttr()

    @property
    def _sync_client(self) -> Optional[ReplyLayer]:
        return self._pair._sync_client

    @property
    def _async_client(self) -> Optional[AsyncReplyLayer]:
        return self._pair._async_client

    @property
    def _closed(self) -> bool:
        return self._pair._closed

    @model_validator(mode="after")
    def _require_api_key(self) -> "ReplyLayerToolkit":
        if not self.api_key.get_secret_value():
            raise ValueError(
                "api_key is required. Pass api_key=... or set the "
                f"{_API_KEY_ENV_VAR} environment variable. "
                "Get a key at https://app.replylayer.ai/connect"
            )
        self._pair = _ClientPair(
            api_key=self.api_key.get_secret_value(),
            base_url=self.base_url,
            owner="ReplyLayerToolkit",
        )
        return self

    def _get_sync_client(self) -> ReplyLayer:
        return self._pair.get_sync()

    def _get_async_client(self) -> AsyncReplyLayer:
        return self._pair.get_async()

    def get_tools(self) -> list[BaseTool]:
        return build_tools(
            get_sync=self._get_sync_client,
            get_async=self._get_async_client,
            default_mailbox_id=self.default_mailbox_id,
        )

    def close(self) -> None:
        """Close the sync HTTP client. Idempotent. If any async tool was
        invoked, call ``aclose()`` as well to close the async client."""
        self._pair.close()

    async def aclose(self) -> None:
        """Close both HTTP clients. Idempotent."""
        await self._pair.aclose()

    def __enter__(self) -> "ReplyLayerToolkit":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    async def __aenter__(self) -> "ReplyLayerToolkit":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

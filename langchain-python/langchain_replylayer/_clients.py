"""Lazy sync+async ReplyLayer client pair with a shared lifecycle.

Not a pydantic model — the toolkit, retriever, and loader each hold one as a
private attribute. Both clients are built with ``strict_outcome=True`` and
created lazily, so a sync-only caller never constructs the async client. The
governed-outcome mapping the send tools rely on only applies when the server
sees ``Prefer: outcome=strict``, which ``strict_outcome=True`` sends.

``close()`` releases the sync client; ``aclose()`` releases both. After either,
the pair is closed and any further client access raises ``RuntimeError`` — a
reused-after-close object fails loudly instead of handing back a live client.
"""
from __future__ import annotations

from typing import Optional

from replylayer import AsyncReplyLayer, ReplyLayer


class _ClientPair:
    def __init__(self, *, api_key: str, base_url: str, owner: str) -> None:
        self._api_key = api_key
        self._base_url = base_url
        # Names the owner in the closed-guard error so the message reads naturally
        # (e.g. "ReplyLayerRetriever is closed.").
        self._owner = owner
        self._sync_client: Optional[ReplyLayer] = None
        self._async_client: Optional[AsyncReplyLayer] = None
        self._closed = False

    def get_sync(self) -> ReplyLayer:
        if self._closed:
            raise RuntimeError(f"{self._owner} is closed.")
        if self._sync_client is None:
            self._sync_client = ReplyLayer(
                api_key=self._api_key,
                base_url=self._base_url,
                strict_outcome=True,
            )
        return self._sync_client

    def get_async(self) -> AsyncReplyLayer:
        if self._closed:
            raise RuntimeError(f"{self._owner} is closed.")
        if self._async_client is None:
            self._async_client = AsyncReplyLayer(
                api_key=self._api_key,
                base_url=self._base_url,
                strict_outcome=True,
            )
        return self._async_client

    def close(self) -> None:
        """Close the sync client. Idempotent. If any async work ran, call
        ``aclose()`` as well to close the async client."""
        self._closed = True
        if self._sync_client is not None:
            self._sync_client.close()
            self._sync_client = None

    async def aclose(self) -> None:
        """Close both clients. Idempotent."""
        self._closed = True
        if self._async_client is not None:
            await self._async_client.aclose()
            self._async_client = None
        if self._sync_client is not None:
            self._sync_client.close()
            self._sync_client = None

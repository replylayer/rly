"""``ReplyLayerLoader`` — a paginated document loader over a mailbox.

Emits scanned, settled messages as ``Document``s for customer-side indexing. It
is the component that exports content past ReplyLayer's safety envelope, so it
carries hard client-side constraints: it only emits settled-state rows with scan
evidence for inbound mail, it never mutates (no mark-read / star / release), and
every body it emits comes from an audited detail read that applies the mailbox's
redaction server-side.

A loaded corpus is a point-in-time copy — deletion, quarantine, and retention
events do NOT propagate to it (no such push event exists). Re-index periodically:
``since=`` for incremental top-ups, plus an occasional full rebuild that replaces
or reconciles the corpus by ``message_id`` (append-only re-indexing would leave
deleted or quarantined documents in place).

Emission is grouped by state — newest-first within each group — not globally
recency-ordered across groups; that is irrelevant for indexing. After any async
use (``alazy_load`` / ``aload``), ``close()`` is insufficient: call ``aclose()``
or use ``async with`` so the async client shuts down cleanly.
"""
from __future__ import annotations

import os
from typing import Any, AsyncIterator, Iterator, Literal, Optional

from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document

from replylayer.errors import NotFoundError

from ._clients import _ClientPair
from ._documents import (
    SAFE_EMIT_STATES,
    apply_truncation_policy,
    inbound_scan_missing,
    message_to_document,
    passes_detail_gates,
)

_DEFAULT_BASE_URL = "https://api.replylayer.ai"
_API_KEY_ENV_VAR = "REPLYLAYER_API_KEY"

# Fixed traversal order — grouped, newest-first within each group.
_ALL_STATUSES = ("available", "delivered", "bounced")


class ReplyLayerLoader(BaseLoader):
    def __init__(
        self,
        mailbox_id: str,
        *,
        api_key: Optional[str] = None,
        base_url: str = _DEFAULT_BASE_URL,
        direction: Optional[Literal["inbound", "outbound"]] = None,
        since: Optional[str] = None,
        until: Optional[str] = None,
        unread: Optional[bool] = None,
        max_messages: Optional[int] = None,
        include_provenance_header: bool = True,
        on_truncated: Literal["include", "skip", "error"] = "include",
    ) -> None:
        resolved_key = api_key or os.environ.get(_API_KEY_ENV_VAR, "")
        if not resolved_key:
            raise ValueError(
                "api_key is required. Pass api_key=... or set the "
                f"{_API_KEY_ENV_VAR} environment variable. "
                "Get a key at https://app.replylayer.ai/connect"
            )
        if max_messages is not None and max_messages < 0:
            raise ValueError("max_messages must be >= 0 (or None for no cap).")
        if on_truncated not in ("include", "skip", "error"):
            raise ValueError(
                "on_truncated must be one of 'include', 'skip', 'error'."
            )

        self.mailbox_id = mailbox_id
        self.base_url = base_url
        self.direction = direction
        self.since = since
        self.until = until
        self.unread = unread
        self.max_messages = max_messages
        self.include_provenance_header = include_provenance_header
        self.on_truncated = on_truncated
        self._pair = _ClientPair(
            api_key=resolved_key, base_url=base_url, owner="ReplyLayerLoader"
        )

    def _statuses(self) -> tuple[str, ...]:
        # Inbound readable rows live in `available`; `delivered`/`bounced` are
        # outbound outcomes, so an inbound-only load needs the one traversal.
        if self.direction == "inbound":
            return ("available",)
        return _ALL_STATUSES

    def _project(self, detail: dict[str, Any]) -> Optional[Document]:
        """Re-check S1 on the detail response, apply the truncation policy, and
        project. Returns ``None`` for a row to skip."""
        if not passes_detail_gates(detail):
            return None
        if not apply_truncation_policy(detail, self.on_truncated):
            return None
        return message_to_document(
            detail, include_provenance_header=self.include_provenance_header
        )

    # --- sync --------------------------------------------------------------

    def lazy_load(self) -> Iterator[Document]:
        """Yield settled messages as ``Document``s, one audited read per unique
        candidate. Truly lazy — no HTTP until iterated. Emission is grouped by
        state (newest-first within each group); stops after ``max_messages``."""
        if self.max_messages == 0:
            return
        client = self._pair.get_sync()
        seen: set[str] = set()
        emitted = 0
        for status in self._statuses():
            for row in client.messages.list(
                self.mailbox_id,
                status=status,
                direction=self.direction,
                since=self.since,
                until=self.until,
                unread=self.unread,
                auto_paginate=True,
            ):
                if not isinstance(row, dict):
                    continue
                row_id = row.get("id")
                # Dedup BEFORE the detail fetch (S1b): a row can transition and
                # reappear under a later status within the same run.
                if not isinstance(row_id, str) or row_id in seen:
                    continue
                seen.add(row_id)
                if row.get("state") not in SAFE_EMIT_STATES:
                    continue
                if inbound_scan_missing(row):
                    continue
                try:
                    detail = client.messages.get(row_id)
                except NotFoundError:
                    continue
                document = self._project(detail)
                if document is None:
                    continue
                yield document
                emitted += 1
                if self.max_messages is not None and emitted >= self.max_messages:
                    return

    # --- async -------------------------------------------------------------

    async def alazy_load(self) -> AsyncIterator[Document]:
        """Async twin of :meth:`lazy_load`. Native — not a thread-wrapped sync."""
        if self.max_messages == 0:
            return
        client = self._pair.get_async()
        seen: set[str] = set()
        emitted = 0
        for status in self._statuses():
            async for row in await client.messages.list(
                self.mailbox_id,
                status=status,
                direction=self.direction,
                since=self.since,
                until=self.until,
                unread=self.unread,
                auto_paginate=True,
            ):
                if not isinstance(row, dict):
                    continue
                row_id = row.get("id")
                if not isinstance(row_id, str) or row_id in seen:
                    continue
                seen.add(row_id)
                if row.get("state") not in SAFE_EMIT_STATES:
                    continue
                if inbound_scan_missing(row):
                    continue
                try:
                    detail = await client.messages.get(row_id)
                except NotFoundError:
                    continue
                document = self._project(detail)
                if document is None:
                    continue
                yield document
                emitted += 1
                if self.max_messages is not None and emitted >= self.max_messages:
                    return

    # --- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        """Close the sync HTTP client. Idempotent. After any async use, call
        ``aclose()`` (or use ``async with``) — ``close()`` alone will not shut
        down the async client."""
        self._pair.close()

    async def aclose(self) -> None:
        """Close both HTTP clients. Idempotent."""
        await self._pair.aclose()

    def __enter__(self) -> "ReplyLayerLoader":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    async def __aenter__(self) -> "ReplyLayerLoader":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

"""``ReplyLayerRetriever`` — a live, search-backed retriever over a mailbox.

Every query re-evaluates state gating, mailbox scoping, redaction, and audit
logging server-side: what crosses the wire is safe-state list previews for the
candidate rows and the audited detail bodies of the selected hits. The retriever
holds no persistent snapshot, so quarantine state and redaction are re-checked on
every query rather than frozen into an external store.

Server search is an AND of all query trigrams over the encrypted subject + body,
ordered by recency. It is a **recency-ordered keyword retriever, not a relevance-
ranked or semantic one** — set chain expectations accordingly. Because search
indexes the full body, a query can match text beyond the returned prefix of a
truncated body; the hit is still correct, but the returned content is a prefix.

Read-only: it never marks read, stars, or releases. Recommended credential is a
mailbox-bound agent key without the trusted-instruction capability; even an
opted-in key is safe, because a per-message trust relaxation is never persisted.
"""
from __future__ import annotations

import os
import unicodedata
from typing import Any, Literal, Optional

from langchain_core.callbacks import (
    AsyncCallbackManagerForRetrieverRun,
    CallbackManagerForRetrieverRun,
)
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from pydantic import Field, PrivateAttr, SecretStr, model_validator

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

# Server-side query rules mirrored client-side: the blind-trigram index has no
# form shorter than 3 code points, and the search schema caps the term at 200.
_MIN_QUERY_LEN = 3
_MAX_QUERY_LEN = 200


class ReplyLayerRetriever(BaseRetriever):
    """Retrieve the ``k`` most recent messages matching a keyword query.

    ``mailbox_id`` is required (the message list is mailbox-scoped). ``k`` is
    clamped to 1..50. Use ``.invoke(query)`` / ``.ainvoke(query)``.
    """

    api_key: SecretStr = Field(
        default_factory=lambda: SecretStr(os.environ.get(_API_KEY_ENV_VAR, "")),
        description=(
            "ReplyLayer API key, held as a SecretStr so it is redacted from "
            "reprs and model_dump(). Falls back to the REPLYLAYER_API_KEY "
            "environment variable when not passed explicitly."
        ),
    )
    base_url: str = Field(
        default=_DEFAULT_BASE_URL, description="ReplyLayer API base URL."
    )
    mailbox_id: str = Field(description="Mailbox to search — the list is scoped to it.")
    k: int = Field(
        default=10, ge=1, le=50, description="Maximum documents to return (1..50)."
    )
    include_provenance_header: bool = Field(
        default=True,
        description="Prepend the untrusted-content provenance header to each body.",
    )
    on_truncated: Literal["include", "skip", "error"] = Field(
        default="include",
        description="Policy for a server-truncated body: include with a marker, "
        "skip the document, or raise.",
    )

    _pair: _ClientPair = PrivateAttr()

    @model_validator(mode="after")
    def _build_clients(self) -> "ReplyLayerRetriever":
        if not self.api_key.get_secret_value():
            raise ValueError(
                "api_key is required. Pass api_key=... or set the "
                f"{_API_KEY_ENV_VAR} environment variable. "
                "Get a key at https://app.replylayer.ai/connect"
            )
        self._pair = _ClientPair(
            api_key=self.api_key.get_secret_value(),
            base_url=self.base_url,
            owner="ReplyLayerRetriever",
        )
        return self

    # --- query + candidate selection ---------------------------------------

    def _normalize_query(self, query: str) -> Optional[str]:
        """NFKC-normalize + strip, mirroring the server rule. Fewer than 3 code
        points -> None (the caller returns [] with zero HTTP), else truncated to
        the schema's 200-character maximum."""
        normalized = unicodedata.normalize("NFKC", query).strip()
        if len(normalized) < _MIN_QUERY_LEN:
            return None
        return normalized[:_MAX_QUERY_LEN]

    def _search_limit(self) -> int:
        # k <= 50, so max(25, 2*k) <= 100 stays within the server's 200 ceiling.
        return max(25, 2 * self.k)

    def _select_candidates(self, rows_by_status: list[list[Any]]) -> list[dict[str, Any]]:
        """Merge the status-constrained result sets by ``(created_at, id)``
        descending, keep only safe-state rows, deduplicate ids (S1b — a row can
        appear under two statuses if it transitions between requests), and take
        the first ``k`` rows under their first-seen state."""
        merged: list[dict[str, Any]] = []
        for rows in rows_by_status:
            for row in rows:
                if isinstance(row, dict) and row.get("state") in SAFE_EMIT_STATES:
                    merged.append(row)
        merged.sort(
            key=lambda r: (str(r.get("created_at") or ""), str(r.get("id") or "")),
            reverse=True,
        )
        selected: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in merged:
            row_id = row.get("id")
            if not isinstance(row_id, str) or row_id in seen:
                continue
            seen.add(row_id)
            selected.append(row)
            if len(selected) >= self.k:
                break
        return selected

    # --- sync --------------------------------------------------------------

    def _get_relevant_documents(
        self, query: str, *, run_manager: CallbackManagerForRetrieverRun
    ) -> list[Document]:
        normalized = self._normalize_query(query)
        if normalized is None:
            return []
        client = self._pair.get_sync()
        rows_by_status = [
            client.messages.list(
                self.mailbox_id,
                search=normalized,
                status=status,
                limit=self._search_limit(),
            ).data
            for status in ("available", "delivered", "bounced")
        ]
        documents: list[Document] = []
        for row in self._select_candidates(rows_by_status):
            # Inbound list rows with no scan evidence are skipped WITHOUT a detail
            # fetch (S1 optimization); the detail check remains authoritative.
            if inbound_scan_missing(row):
                continue
            try:
                detail = client.messages.get(row["id"])
            except NotFoundError:
                # Deleted between list and get — skip.
                continue
            document = self._project(detail)
            if document is not None:
                documents.append(document)
        return documents

    # --- async -------------------------------------------------------------

    async def _aget_relevant_documents(
        self, query: str, *, run_manager: AsyncCallbackManagerForRetrieverRun
    ) -> list[Document]:
        normalized = self._normalize_query(query)
        if normalized is None:
            return []
        client = self._pair.get_async()
        rows_by_status = []
        for status in ("available", "delivered", "bounced"):
            page = await client.messages.list(
                self.mailbox_id,
                search=normalized,
                status=status,
                limit=self._search_limit(),
            )
            rows_by_status.append(page.data)
        documents: list[Document] = []
        for row in self._select_candidates(rows_by_status):
            if inbound_scan_missing(row):
                continue
            try:
                detail = await client.messages.get(row["id"])
            except NotFoundError:
                continue
            document = self._project(detail)
            if document is not None:
                documents.append(document)
        return documents

    # --- shared projection -------------------------------------------------

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

    # --- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        """Close the sync HTTP client. Idempotent. Call ``aclose()`` too if any
        async retrieval ran."""
        self._pair.close()

    async def aclose(self) -> None:
        """Close both HTTP clients. Idempotent."""
        await self._pair.aclose()

    def __enter__(self) -> "ReplyLayerRetriever":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    async def __aenter__(self) -> "ReplyLayerRetriever":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

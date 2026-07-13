"""LangChain integrations for ReplyLayer — governed email for AI agents.

Thin clients over the published ``replylayer`` SDK across LangChain's three
integration surfaces: the ``ReplyLayerToolkit`` (agent action tools), the
``ReplyLayerLoader`` (bulk-read an inbox as ``Document``s for indexing), and the
``ReplyLayerRetriever`` (query -> relevant ``Document``s, re-checking state and
redaction on every query). The loader and retriever preserve ReplyLayer's safety
envelope rather than bypass it: they emit only settled-state messages with scan
evidence for inbound mail, never persist a per-message trust relaxation, and
frame every body as untrusted data. This package is versioned independently of
the ``replylayer`` SDK and is not part of the TypeScript<->Python method-mirror
contract.

``__all__`` below is the version-contracted public API; everything else
(``tools``, ``toolkit``, ``loader``, ``retriever``, and the underscore-prefixed
modules) is private.
"""
from .loader import ReplyLayerLoader
from .retriever import ReplyLayerRetriever
from .toolkit import ReplyLayerToolkit

__version__ = "0.2.0"

__all__ = [
    "ReplyLayerToolkit",
    "ReplyLayerLoader",
    "ReplyLayerRetriever",
    "__version__",
]

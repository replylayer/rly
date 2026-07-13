"""LangChain tools for ReplyLayer — governed email for AI agents.

Thin wrappers over the published ``replylayer`` SDK: every send still passes the
allowlist, quota, human-approval, and content-scanning gates. This package is
versioned independently of the ``replylayer`` SDK and is not part of the
TypeScript<->Python method-mirror contract.

``__all__`` below is the version-contracted public API; everything else
(``tools``, ``toolkit``, ``_governance``) is private.
"""
from .toolkit import ReplyLayerToolkit

__version__ = "0.1.1"

__all__ = [
    "ReplyLayerToolkit",
    "__version__",
]

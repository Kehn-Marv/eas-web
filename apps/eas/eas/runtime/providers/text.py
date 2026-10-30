"""Sanitisation for text that arrives from an external tool provider.

Tool names and descriptions from an external provider are **third-party strings**. They reach the model through
the ``extended_tools`` system-prompt block and through tool schemas — the
highest-trust position in a turn. Two properties therefore have to hold
before any of it is rendered:

* **one line, one entry** — the manifest is a line-oriented Markdown list, so
  a description containing newlines (or a Markdown heading) could forge extra
  entries or a fake section that reads like instructions;
* **bounded length** — a description is metadata, not a document. Without a
  cap, N installed providers turn into an unbounded always-on prompt cost
  (and a place to hide a wall of injected text).

This module is the single place both properties are enforced. Callers keep
the *full* text for the on-demand schema (``load_tools``) and render the
capped, flattened form in the manifest.
"""

from __future__ import annotations

import re
import unicodedata

# Manifest lines are one-per-tool and always-on; the full description still
# reaches the model with the schema once the tool is actually loaded.
MANIFEST_DESCRIPTION_MAX_CHARS = 180

_WHITESPACE_RUN_RE = re.compile(r"\s+")
_BLANK_RUN_RE = re.compile(r"\n{3,}")


def sanitize_provider_text(text: str, *, max_chars: int | None = None) -> str:
    """Flatten *text* to a single bounded line safe to embed in a prompt.

    Collapses every whitespace run (newlines included) to one space and drops
    Unicode control/format characters — the latter covers zero-width joiners
    and BiDi overrides, which can hide or visually reorder content that a
    reviewer reading the manifest would never see.
    """
    if not text:
        return ""
    # Whitespace first: newlines and tabs are themselves control characters, so
    # dropping them before collapsing would fuse the words on either side.
    cleaned = _WHITESPACE_RUN_RE.sub(" ", str(text))
    cleaned = "".join(char for char in cleaned if unicodedata.category(char) not in {"Cc", "Cf"})
    cleaned = _WHITESPACE_RUN_RE.sub(" ", cleaned).strip()
    if max_chars is not None and max_chars > 0 and len(cleaned) > max_chars:
        cleaned = cleaned[:max_chars].rstrip() + "…"
    return cleaned


__all__ = [
    "MANIFEST_DESCRIPTION_MAX_CHARS",
    "sanitize_provider_text",
]

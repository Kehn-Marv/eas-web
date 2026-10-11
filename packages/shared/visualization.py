"""Deterministic source-grounded visualization planning helpers."""

import hashlib
import re

from packages.schemas.visualizations import (
    AccessibilityMetadata,
    InteractionDefinition,
    VisualElement,
    VisualizationSourceRef,
    VisualizationSpec,
    VisualizationType,
)


def build_visualization_spec(query: str, hits: list[object]) -> VisualizationSpec:
    """Build a safe visual outline from retrieved excerpts; never emits executable markup."""
    if not hits:
        raise ValueError("A source-grounded visualization requires retrieved sources")

    source_refs = [
        VisualizationSourceRef(
            document_id=hit.document_id,
            page_number=hit.page_number,
            block_id=hit.block_id,
            chunk_id=hit.chunk_id,
            quote_or_excerpt=hit.content[:500],
        )
        for hit in hits[:10]
    ]
    elements: list[VisualElement] = []
    interactions: list[InteractionDefinition] = []
    seen: set[str] = set()
    for source_index, hit in enumerate(hits[:10]):
        sentences = re.split(r"(?<=[.!?])\s+", " ".join(hit.content.split()))
        candidates = sentences if len(hits) == 1 else sentences[:2]
        for sentence in candidates:
            label = sentence.strip()
            if not label:
                continue
            label = label[:300]
            fingerprint = label.casefold()
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            element_id = f"source-{len(elements) + 1}"
            elements.append(
                VisualElement(
                    id=element_id,
                    kind="node",
                    label=label,
                    data={"source_ref_index": source_index},
                )
            )
            interactions.append(
                InteractionDefinition(
                    id=f"select-{len(elements)}",
                    trigger="click",
                    target_id=element_id,
                    action="select",
                )
            )
            if len(elements) >= 8:
                break
        if len(elements) >= 8:
            break
    if not elements:
        raise ValueError("Retrieved source text did not produce a renderable visual")

    visual_type = (
        VisualizationType.FLOWCHART
        if re.search(r"\b(step|process|sequence|procedure)\b", query, re.IGNORECASE)
        else VisualizationType.CONCEPT_MAP
    )
    return VisualizationSpec(
        schema_version="1.0",
        type=visual_type,
        title="Source-grounded learning outline",
        pedagogical_goal="Organize retrieved source passages into selectable visual points.",
        source_refs=source_refs,
        props={"layout": "vertical", "reading_order": "top_to_bottom"},
        visual_elements=elements,
        interactions=interactions,
        state_model={"selected_element_id": None},
        checkpoints=[],
        accessibility=AccessibilityMetadata(
            alt_text="A selectable outline of relevant passages from the study material.",
            text_alternative="; ".join(element.label for element in elements),
            keyboard_accessible=True,
        ),
    )


def visualization_hash(spec: VisualizationSpec) -> str:
    return hashlib.sha256(spec.model_dump_json().encode("utf-8")).hexdigest()

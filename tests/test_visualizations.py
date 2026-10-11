from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from packages.schemas.visualizations import (
    VisualizationSpec,
    to_json_schema,
    validate_source_references,
)
from services.api.eas_api.main import app


def valid_spec(**updates):
    payload = {
        "schema_version": "1.0",
        "type": "flowchart",
        "title": "Energy transfer",
        "pedagogical_goal": "Show the direction of energy transfer.",
        "source_refs": [
            {
                "document_id": str(document_id),
                "page_number": 2,
                "block_id": str(block_id),
                "chunk_id": str(chunk_id),
            }
        ],
        "props": {"direction": "left-to-right"},
        "visual_elements": [
            {"id": "source", "kind": "node", "label": "Source"},
            {"id": "receiver", "kind": "node", "label": "Receiver"},
        ],
        "interactions": [
            {
                "id": "select-receiver",
                "trigger": "click",
                "target_id": "receiver",
                "action": "select",
            }
        ],
        "state_model": {"selected": None},
        "checkpoints": [],
        "accessibility": {
            "alt_text": "A source points toward a receiver.",
            "text_alternative": "Energy moves from source to receiver.",
            "keyboard_accessible": True,
        },
    }
    payload.update(updates)
    return payload


document_id = uuid4()
block_id = uuid4()
chunk_id = uuid4()


def test_visualization_spec_validates_and_references_retrieved_sources():
    spec = VisualizationSpec.model_validate(valid_spec())
    assert validate_source_references(spec, {(document_id, 2, block_id, chunk_id)})
    assert "properties" in to_json_schema()


def test_visualization_spec_rejects_executable_content_and_unknown_targets():
    payload = valid_spec(props={"script": "alert(1)"})
    with pytest.raises(ValidationError):
        VisualizationSpec.model_validate(payload)
    payload = valid_spec(
        interactions=[
            {
                "id": "bad-target",
                "trigger": "click",
                "target_id": "missing",
                "action": "select",
            }
        ]
    )
    with pytest.raises(ValidationError):
        VisualizationSpec.model_validate(payload)


def test_versioned_visualization_schema_is_public():
    with TestClient(app) as client:
        response = client.get("/v1/schemas/visualization/v1")
    assert response.status_code == 200
    assert response.json()["properties"]["schema_version"]["pattern"] == r"^1\.0$"

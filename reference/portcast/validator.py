"""JSON Schema-based validator for PortCast documents.

The schema is loaded from `<repo>/schema/portcast.schema.json` relative to
this package; production embedders can pass their own copy via
`validate(doc, schema=...)`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from jsonschema import Draft202012Validator
from jsonschema import ValidationError as _JSONSchemaError


class ValidationError(Exception):
    """Raised when a document fails to validate against the PortCast schema."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("PortCast validation failed:\n  - " + "\n  - ".join(errors))


_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "portcast.schema.json"
_cached_schema: Optional[dict[str, Any]] = None


def _load_schema() -> dict[str, Any]:
    global _cached_schema
    if _cached_schema is None:
        with _SCHEMA_PATH.open("r", encoding="utf-8") as fh:
            _cached_schema = json.load(fh)
    return _cached_schema


def validate(document: Any, schema: Optional[dict[str, Any]] = None) -> None:
    """Validate a PortCast document dictionary.

    Raises:
        ValidationError: if the document fails one or more schema rules.
    """
    schema = schema or _load_schema()
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(document), key=lambda e: list(e.absolute_path))
    if errors:
        raise ValidationError([_format_error(e) for e in errors])


def _format_error(err: _JSONSchemaError) -> str:
    path = "/".join(str(p) for p in err.absolute_path) or "<root>"
    return f"{path}: {err.message}"

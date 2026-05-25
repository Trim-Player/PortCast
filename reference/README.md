# PortCast — Python reference implementation

Reference implementation of the [PortCast protocol](../SPECIFICATION.md):
dataclass models, JSON Schema validation, OPML interop, and a CLI.

## Install

```bash
pip install -e .
```

## CLI

```bash
portcast validate              doc.portcast.json
portcast opml-to-portcast      subs.opml -o out.portcast.json
portcast portcast-to-opml      doc.portcast.json -o subs.opml
portcast inspect               doc.portcast.json
```

## Library

```python
from portcast import PortCastDocument, validate, import_opml

doc = import_opml(open("subs.opml").read())
data = doc.to_dict()
validate(data)
```

See `tests/` for further examples.

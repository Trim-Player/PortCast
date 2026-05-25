"""Command-line interface for the PortCast reference impl.

Usage:
    portcast validate doc.portcast.json
    portcast opml-to-portcast subscriptions.opml [-o out.portcast.json]
    portcast portcast-to-opml doc.portcast.json [-o out.opml]
    portcast inspect doc.portcast.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .models import PortCastDocument
from .opml import export_opml, import_opml
from .validator import ValidationError, validate


def _cmd_validate(args: argparse.Namespace) -> int:
    data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    try:
        validate(data)
    except ValidationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"OK: {args.file} is a valid PortCast {data.get('portcast')} document")
    return 0


def _cmd_opml_to_portcast(args: argparse.Namespace) -> int:
    opml_text = Path(args.file).read_text(encoding="utf-8")
    doc = import_opml(opml_text)
    out_text = json.dumps(doc.to_dict(), indent=2, ensure_ascii=False)
    _write_output(out_text, args.out)
    return 0


def _cmd_portcast_to_opml(args: argparse.Namespace) -> int:
    data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    validate(data)
    doc = PortCastDocument.from_dict(data)
    out_text = export_opml(doc)
    _write_output(out_text, args.out)
    return 0


def _cmd_inspect(args: argparse.Namespace) -> int:
    data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    subs = data.get("subscriptions", [])
    eps = data.get("episodes", [])
    completed = sum(1 for e in eps if e.get("status") == "completed")
    in_progress = sum(1 for e in eps if e.get("status") == "in_progress")
    bookmarks = len(data.get("bookmarks", []) or [])
    print(f"PortCast version : {data.get('portcast')}")
    print(f"Generator        : {data.get('generator', {}).get('name')}")
    print(f"Generated at     : {data.get('generatedAt')}")
    print(f"Subscriptions    : {len(subs)}")
    print(f"Episodes tracked : {len(eps)}  "
          f"({completed} completed, {in_progress} in progress)")
    print(f"Bookmarks        : {bookmarks}")
    return 0


def _write_output(text: str, out_path: str | None) -> None:
    if out_path:
        Path(out_path).write_text(text, encoding="utf-8")
        print(f"Wrote {out_path}", file=sys.stderr)
    else:
        sys.stdout.write(text)
        if not text.endswith("\n"):
            sys.stdout.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="portcast", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_validate = sub.add_parser("validate", help="Validate a PortCast document")
    p_validate.add_argument("file")
    p_validate.set_defaults(func=_cmd_validate)

    p_o2p = sub.add_parser("opml-to-portcast", help="Convert OPML -> PortCast")
    p_o2p.add_argument("file")
    p_o2p.add_argument("-o", "--out", help="Output path (default: stdout)")
    p_o2p.set_defaults(func=_cmd_opml_to_portcast)

    p_p2o = sub.add_parser("portcast-to-opml", help="Convert PortCast -> OPML")
    p_p2o.add_argument("file")
    p_p2o.add_argument("-o", "--out", help="Output path (default: stdout)")
    p_p2o.set_defaults(func=_cmd_portcast_to_opml)

    p_inspect = sub.add_parser("inspect", help="Print a short summary of a document")
    p_inspect.add_argument("file")
    p_inspect.set_defaults(func=_cmd_inspect)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

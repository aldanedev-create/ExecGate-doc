#!/usr/bin/env python3
"""Generate docs-bundle.json from a docs/ directory."""
import argparse, datetime as dt, json, re
from pathlib import Path

SECTION_NAMES = {
    "": "Overview",
    "getting-started": "Getting Started",
    "lessons": "Lessons",
    "adr": "Architecture Decisions",
    "integrations": "Integrations",
    "reference": "Reference",
}

TITLE_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def extract_title(md: str, fallback: str) -> str:
    m = TITLE_RE.search(md)
    return m.group(1).strip() if m else fallback


def strip_frontmatter(md: str) -> str:
    if md.startswith("---\n"):
        end = md.find("\n---\n", 4)
        if end != -1:
            return md[end + 5:]
    return md


def section_for(rel: Path) -> str:
    parts = rel.parts
    key = "" if len(parts) == 1 else parts[0]
    return SECTION_NAMES.get(key, key.replace("-", " ").title())


def build(docs_dir: Path, version: str) -> dict:
    sections: dict[str, list] = {}
    content: dict[str, str] = {}

    for md_path in sorted(docs_dir.rglob("*.md")):
        if md_path.name.startswith("."):
            continue
        rel = md_path.relative_to(docs_dir)
        key = rel.with_suffix("").as_posix()
        if key.lower() == "readme":
            continue

        raw = md_path.read_text(encoding="utf-8")
        body = strip_frontmatter(raw)
        title = extract_title(body, rel.stem.replace("-", " ").title())

        section = section_for(rel)
        sections.setdefault(section, []).append({
            "title": title,
            "path": key,
            "_stem": rel.stem,
        })
        content[key] = body

    # Preferred section order.
    order = ["Overview", "Getting Started", "Lessons",
             "Reference", "Integrations", "Architecture Decisions"]
    nav = []
    for name in sorted(
        sections,
        key=lambda n: (order.index(n) if n in order else len(order), n),
    ):
        pages = sorted(sections[name], key=lambda p: p["_stem"])
        for p in pages:
            del p["_stem"]
        nav.append({"name": name, "pages": pages})

    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "version": version,
        "navigation": nav,
        "content": content,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--docs", type=Path, default=Path("../docs"))
    parser.add_argument("--out", type=Path, default=Path("docs-bundle.json"))
    parser.add_argument("--version", default="0.1.0")
    args = parser.parse_args()

    if not args.docs.is_dir():
        raise SystemExit(f"docs directory not found: {args.docs}")

    bundle = build(args.docs, args.version)
    args.out.write_text(json.dumps(bundle, indent=2, ensure_ascii=False),
                        encoding="utf-8")
    print(f"Wrote {args.out}: {len(bundle['content'])} pages, "
          f"{len(bundle['navigation'])} sections, "
          f"{args.out.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
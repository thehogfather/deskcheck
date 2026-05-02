#!/usr/bin/env python3
"""Parser for phased roadmaps (fabrick style).

Extracts a phase section from docs/roadmap.md, follows the "Based on:" links
to one or more spec files, and pulls the authoritative functional requirements
(FR-XX-NN entries) and Definition of Done from the spec. If the spec references
ports in docs/technical-choices.md, those are surfaced too.

Output: JSON to stdout.

Roadmap format expected:
  ## Priority: Now — Phase 0 Foundations
  ...
  ### 0.4 Run lifecycle: queue, heartbeat, cancellation, reaper
  - **Personas**: Operator, Data Engineer
  - **Based on**: [admin-job-queue-spec.md](specs/implemented/admin-job-queue-spec.md),
                  [worker-heartbeat-spec.md](specs/proposed/worker-heartbeat-spec.md)
  - **Definition of done**:
    - [ ] Crashing a worker...
    - [ ] Cancelling a running run...

Spec format expected (section headings):
  ## 5. Functional requirements
    - **FR-RL-01** — Runs table: ...
  ## 8. Definition of done
    - [ ] Schema migrated...

Usage:
  phased_roadmap_parser.py <phase-id> --repo-root <path> [--roadmap PATH] \
                                      [--choices PATH]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# Heading for a phase deliverable: "### 0.4 Title..." or "### 0.1a Title..."
# Phase IDs may have a trailing lowercase letter for sub-phases (0.1a, 0.1b…)
PHASE_RE = re.compile(r"^###\s+(\d+(?:\.\d+)*[a-z]?)\s+(.+?)\s*$")
# Based-on line in roadmap (may be a bullet: "- **Based on**: ...")
BASED_ON_RE = re.compile(r"\*\*Based on\*\*:\s*(.+?)\s*$", re.M)
# Top-of-roadmap mapping row: | 0.4 | [name](specs/proposed/xxx.md) |
# Supports single id (0.4), slash-joined (0.2 / 0.3), and sub-phases (0.1a)
MAP_ROW_RE = re.compile(
    r"^\|\s*(\d+(?:\.\d+)*[a-z]?(?:\s*/\s*\d+(?:\.\d+)*[a-z]?)*)\s*\|\s*"
    r"\[([^\]]+)\]\(([^)]+\.md)\)\s*\|",
    re.M,
)
# Markdown link with .md target
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+\.md)\)")
# Checkbox list item
CB_RE = re.compile(r"^\s*-\s+\[[ xX]\]\s+(.+?)\s*$", re.M)
# FR entry — "- **FR-XX-NN** — text" or "FR-XX-NN:"
FR_RE = re.compile(r"\*\*FR-([A-Z]{1,4})-(\d+)\*\*\s*[—\-:]\s*(.+?)(?:\n|$)")
# "Depends on: ..." line (in roadmap or spec header). Capture the whole
# content; a second pass extracts individual phase IDs or spec names.
# The optional `\**` handles markdown-bolded roadmap bullets like
# "- **Depends on**: 0.1a". In spec headers the bolding is absent.
DEPENDS_LINE_RE = re.compile(r"(?:Depends on|Gate|Requires)\**\s*:\s*(.+?)\s*$", re.M)
# Phase id anywhere in free text (for extracting from Depends-on line)
PHASE_ID_IN_TEXT_RE = re.compile(r"\b(\d+(?:\.\d+)+[a-z]?)\b")
# Scope directive inside a phase section: "**Spec scope**: FR-PS-01, FR-PS-02"
# or "**Spec scope**: FR-PS-01..05" (range form) — either form is allowed
SCOPE_LINE_RE = re.compile(r"\*\*Spec scope\*\*:\s*(.+?)\s*$", re.M)
FR_CODE_RE = re.compile(r"FR-([A-Z]{1,4})-(\d+)")
FR_RANGE_RE = re.compile(r"FR-([A-Z]{1,4})-(\d+)\s*\.\.\s*(\d+)")


def _phase_section(lines: list[str], phase_id: str) -> tuple[int, int, str] | None:
    start = None
    title = None
    for i, ln in enumerate(lines):
        m = PHASE_RE.match(ln)
        if m and m.group(1) == phase_id:
            start = i
            title = m.group(2)
            break
    if start is None:
        return None
    end = start + 1
    while end < len(lines):
        ln = lines[end]
        if ln.startswith("### ") or ln.startswith("## ") or ln.startswith("# "):
            break
        end += 1
    return start, end, title or ""


def _extract_checkboxes(text: str) -> list[str]:
    return [m.group(1).strip() for m in CB_RE.finditer(text)]


def _parse_spec(spec_path: Path, known_port_ids: set[str]) -> dict[str, Any]:
    if not spec_path.exists():
        return {"exists": False, "path": str(spec_path)}
    text = spec_path.read_text()
    # Functional requirements section (captures all ### subsections)
    frs: list[dict[str, str]] = []
    fr_section = _section(text, r"## \d+\. Functional requirements")
    if fr_section:
        for m in FR_RE.finditer(fr_section):
            frs.append({
                "code": f"FR-{m.group(1)}-{m.group(2)}",
                "text": m.group(3).strip(),
            })
    # Definition of done
    dod_section = _section(text, r"## \d+\. Definition of done")
    dod = _extract_checkboxes(dod_section) if dod_section else []
    # Ports — look for the Replaceability contract section and filter any
    # backtick-wrapped tokens against the known port ID set from
    # technical-choices.md. This prevents picking up importlinter rule names
    # or other incidental backticks.
    ports: list[str] = []
    rc = _section(text, r"## \d+a\. Replaceability contract")
    if rc and known_port_ids:
        for tok in re.findall(r"`([a-z][a-z0-9\-]+)`", rc):
            if tok in known_port_ids and tok not in ports:
                ports.append(tok)
    return {
        "exists": True,
        "path": str(spec_path),
        "functional_requirements": frs,
        "definition_of_done": dod,
        "ports": ports,
    }


def _section(text: str, heading_pattern: str) -> str | None:
    """Return the body of a markdown section whose heading matches the regex.

    Stops at the next heading of SAME OR HIGHER level — subsections are kept.
    Heading level is counted as the number of leading '#' characters.
    """
    lines = text.splitlines()
    pat = re.compile(heading_pattern)
    start = None
    start_level = None
    for i, ln in enumerate(lines):
        if pat.match(ln):
            start = i + 1
            # Count leading #s of the matched heading
            start_level = len(ln) - len(ln.lstrip("#"))
            break
    if start is None or start_level is None:
        return None
    end = start
    header_re = re.compile(r"^(#{1,6})\s")
    while end < len(lines):
        m = header_re.match(lines[end])
        if m and len(m.group(1)) <= start_level:
            break
        end += 1
    return "\n".join(lines[start:end])


def _parse_choices(choices_path: Path, ports: list[str]) -> dict[str, Any]:
    if not choices_path.exists():
        return {}
    text = choices_path.read_text()
    result: dict[str, Any] = {}
    for port in ports:
        # Each entry starts with `### <port>` followed by a yaml fence
        pat = re.compile(
            rf"^###\s+`{re.escape(port)}`\s*$\n+```yaml\n(.+?)\n```",
            re.S | re.M,
        )
        m = pat.search(text)
        if m:
            result[port] = {"registry_yaml": m.group(1).strip()}
    return result


def _registered_port_ids(choices_path: Path) -> set[str]:
    """Return the set of port IDs registered in technical-choices.md.

    Matches headings of the form: ### `<id>`
    """
    if not choices_path.exists():
        return set()
    text = choices_path.read_text()
    return set(re.findall(r"^###\s+`([a-z][a-z0-9\-]+)`\s*$", text, re.M))


def _roadmap_phase_deps(section: str) -> list[str]:
    """Extract phase IDs from a roadmap phase section's 'Depends on:' line(s).

    Skips ranges/ids equal to an em-dash or '—' (meaning no deps).
    """
    deps: list[str] = []
    for m in DEPENDS_LINE_RE.finditer(section):
        line = m.group(1)
        # em-dash / hyphen variants indicate no deps
        stripped = line.strip().replace("—", "").replace("-", "").strip()
        if not stripped:
            continue
        deps.extend(PHASE_ID_IN_TEXT_RE.findall(line))
    # de-duplicate preserving order
    seen: set[str] = set()
    out: list[str] = []
    for d in deps:
        if d not in seen:
            seen.add(d)
            out.append(d)
    return out


def _spec_header_deps(spec_path: Path) -> list[str]:
    """Extract spec names from a spec's header 'Depends on:' line.

    Format observed in fabrick specs:
      - Depends on: —
      - Depends on: platform-shell-spec (Phase 0.1)
      - Depends on: platform-shell-spec, resource-model-spec

    Returns a list of spec base names (without .md, without (Phase N.y)
    annotation). Everything before "## 1." or the first major section is
    considered the header block.
    """
    if not spec_path.exists():
        return []
    text = spec_path.read_text()
    # Confine to header (before "## 1." — spec template puts Document status first)
    cutoff = re.search(r"\n## \d+\. ", text)
    header = text[: cutoff.start()] if cutoff else text
    m = DEPENDS_LINE_RE.search(header)
    if not m:
        return []
    line = m.group(1)
    # em-dash / hyphen variants → no deps
    if line.strip().replace("—", "").replace("-", "").strip() == "":
        return []
    # Tokenise by comma; strip each; drop trailing "(Phase X.Y)" annotations
    tokens: list[str] = []
    for raw in line.split(","):
        t = raw.strip()
        # Drop parenthetical annotations
        t = re.sub(r"\s*\(.*?\)\s*", "", t).strip()
        if t and t not in tokens:
            tokens.append(t)
    return tokens


def _build_spec_to_phase_map(roadmap_path: Path) -> dict[str, list[str]]:
    """Reverse-index the roadmap's mapping table: spec base name → [phase ids].

    A spec that serves multiple sub-phases (e.g. platform-shell-spec →
    0.1a/0.1b/0.1c/0.1d) returns all those IDs.
    """
    out: dict[str, list[str]] = {}
    if not roadmap_path.exists():
        return out
    text = roadmap_path.read_text()
    for m in MAP_ROW_RE.finditer(text):
        ids = [p.strip() for p in m.group(1).split("/")]
        spec_name = m.group(2).strip()  # e.g. "platform-shell-spec"
        # Also accept the path basename as an alias
        path_base = Path(m.group(3)).stem
        for key in {spec_name, path_base}:
            existing = out.get(key, [])
            out[key] = existing + [i for i in ids if i not in existing]
    return out


def _expand_spec_deps(spec_dep_names: list[str],
                      spec_to_phase: dict[str, list[str]],
                      current_phase: str) -> list[str]:
    """Translate spec-name deps → phase IDs, excluding self-references."""
    out: list[str] = []
    for name in spec_dep_names:
        for pid in spec_to_phase.get(name, []):
            if pid == current_phase or pid in out:
                continue
            out.append(pid)
    return out


def _filter_frs_by_scope(frs: list[dict[str, str]], scope_spec: str) -> list[dict[str, str]]:
    """Filter FRs to the set declared by a **Spec scope** line.

    Scope may list explicit codes (`FR-PS-01, FR-PS-02`) or ranges
    (`FR-PS-01..05`). Unknown prefixes are ignored (caller's problem).
    """
    if not scope_spec.strip():
        return frs
    wanted: set[str] = set()
    # Ranges first so the plain finditer after doesn't double-add endpoints
    for m in FR_RANGE_RE.finditer(scope_spec):
        prefix, lo, hi = m.group(1), int(m.group(2)), int(m.group(3))
        for n in range(lo, hi + 1):
            wanted.add(f"FR-{prefix}-{n:02d}")
    # Strip out the range matches so we don't re-match their first/last codes
    residual = FR_RANGE_RE.sub("", scope_spec)
    for m in FR_CODE_RE.finditer(residual):
        wanted.add(f"FR-{m.group(1)}-{int(m.group(2)):02d}")
    # Spec-file FR codes may use arbitrary padding (01 vs 1). Normalise both.
    def norm(code: str) -> str:
        m = re.match(r"FR-([A-Z]{1,4})-(\d+)", code)
        return f"FR-{m.group(1)}-{int(m.group(2)):02d}" if m else code
    wanted_norm = {norm(w) for w in wanted}
    return [f for f in frs if norm(f["code"]) in wanted_norm]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("phase_id", help="Phase id like 0.4 or 4.3")
    ap.add_argument("--repo-root", default=".",
                    help="Repository root (for resolving spec paths)")
    ap.add_argument("--roadmap", default="docs/roadmap.md",
                    help="Path to roadmap relative to repo root")
    ap.add_argument("--choices", default="docs/technical-choices.md",
                    help="Path to technical-choices registry relative to repo root")
    args = ap.parse_args()

    repo_root = Path(args.repo_root).resolve()
    roadmap_path = repo_root / args.roadmap
    if not roadmap_path.exists():
        print(f"roadmap not found: {roadmap_path}", file=sys.stderr)
        return 2
    lines = roadmap_path.read_text().splitlines()
    found = _phase_section(lines, args.phase_id)
    if not found:
        print(f"phase {args.phase_id} not found in {roadmap_path}", file=sys.stderr)
        return 2
    start, end, title = found
    section_text = "\n".join(lines[start:end])

    # First: check top-of-roadmap mapping table (phase id → consolidated spec).
    # Fabrick uses this because "Based on:" links point to prior-repo paths
    # that no longer exist in the new repo. This table is authoritative when
    # present.
    spec_links: list[dict[str, str]] = []
    roadmap_text = roadmap_path.read_text()
    for row in MAP_ROW_RE.finditer(roadmap_text):
        ids = {p.strip() for p in row.group(1).split("/")}
        if args.phase_id in ids:
            rel = row.group(3)
            abs_spec = (roadmap_path.parent / rel).resolve()
            spec_links.append({
                "name": row.group(2),
                "relative_path": rel,
                "absolute_path": str(abs_spec),
                "source": "mapping_table",
            })

    # Fallback: parse "Based on:" links inline (standard roadmap format or
    # repos without a mapping table)
    if not spec_links:
        m = BASED_ON_RE.search(section_text)
        if m:
            for link in MD_LINK_RE.finditer(m.group(1)):
                rel = link.group(2)
                abs_spec = (roadmap_path.parent / rel).resolve()
                spec_links.append({
                    "name": link.group(1),
                    "relative_path": rel,
                    "absolute_path": str(abs_spec),
                    "source": "based_on",
                })

    # Load port IDs registered in the choices file (used to filter spec
    # backtick tokens down to real port IDs)
    choices_path = repo_root / args.choices
    known_ports = _registered_port_ids(choices_path)

    # Load specs + apply scope filter if the phase section declares one
    scope_line = ""
    sm = SCOPE_LINE_RE.search(section_text)
    if sm:
        scope_line = sm.group(1)

    specs = {}
    all_ports: list[str] = []
    spec_header_dep_names: list[str] = []
    for s in spec_links:
        sp = Path(s["absolute_path"])
        parsed = _parse_spec(sp, known_ports)
        if scope_line and parsed.get("functional_requirements"):
            filtered = _filter_frs_by_scope(parsed["functional_requirements"], scope_line)
            parsed["functional_requirements_unfiltered_count"] = len(parsed["functional_requirements"])
            parsed["functional_requirements"] = filtered
            parsed["scope_applied"] = scope_line
        specs[s["name"]] = parsed
        all_ports.extend(parsed.get("ports", []))
        spec_header_dep_names.extend(_spec_header_deps(sp))

    all_ports = sorted(set(all_ports))

    # Technical choices details for the ports touched
    ports_detail = _parse_choices(choices_path, all_ports) if all_ports else {}

    # DoD from the roadmap section itself
    roadmap_dod: list[str] = []
    if "**Definition of done**" in section_text:
        after = section_text.split("**Definition of done**", 1)[1]
        roadmap_dod = _extract_checkboxes(after)

    # Dependencies: combine roadmap-declared phase IDs with spec-header deps
    # translated via the roadmap's mapping table.
    roadmap_deps = _roadmap_phase_deps(section_text)
    spec_to_phase = _build_spec_to_phase_map(roadmap_path)
    spec_deps = _expand_spec_deps(spec_header_dep_names, spec_to_phase, args.phase_id)

    combined: list[str] = []
    for d in roadmap_deps + spec_deps:
        if d != args.phase_id and d not in combined:
            combined.append(d)

    out = {
        "phase_id": args.phase_id,
        "title": title,
        "roadmap_path": str(roadmap_path),
        "roadmap_section": section_text,
        "roadmap_dod": roadmap_dod,
        "depends_on": combined,
        "depends_on_sources": {
            "roadmap": roadmap_deps,
            "spec_header": spec_header_dep_names,
            "spec_header_expanded": spec_deps,
        },
        "scope": scope_line,
        "spec_links": spec_links,
        "specs": specs,
        "ports_touched": all_ports,
        "ports_detail": ports_detail,
        "acceptance_sources": {
            "primary": "spec.functional_requirements",
            "secondary": "spec.definition_of_done",
            "tertiary": "roadmap.definition_of_done",
        },
    }
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

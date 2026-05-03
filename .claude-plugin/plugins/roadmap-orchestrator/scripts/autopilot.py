#!/usr/bin/env python3
"""Autopilot dispatcher — launches orchestrator sessions for eligible roadmap phases.

Idempotent. Each invocation:
  1. Reads .orchestrator/config.yaml for MAX_PARALLEL_SESSIONS + MAX_PHASE_FAILURES.
  2. Reads .claude/roadmap-claims.json to count active (non-stale) claims.
  3. Walks docs/roadmap.md, computing eligibility for each phase id.
  4. Dispatches detached `claude -p` processes for the first N eligible phases
     where N = MAX_PARALLEL_SESSIONS - active_count.
  5. Exits.

Intended invocation:
  - Ad-hoc:     python3 autopilot.py
  - Claude loop:  /loop 10m /roadmap autopilot
  - Cron:       */10 * * * * cd $REPO && python3 autopilot.py >> .orchestrator/autopilot.log

Pause without kill:
  touch .orchestrator/autopilot.paused
Resume:
  rm .orchestrator/autopilot.paused

Stop a phase being retried indefinitely:
  The orchestrator releases claims with status=abandoned on failure; autopilot
  increments a 'failures' counter on the claim entry. After MAX_PHASE_FAILURES
  (default 3), autopilot skips that phase until cleared manually.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Matches both fabrick-style "### 0.4 Title" and feature-numbered "### 1. Title".
# Group 1 = id (e.g. "0.4", "1", "14"), group 2 = remainder of the heading.
PHASE_HEADING_RE = re.compile(r"^###\s+(\d+(?:\.\d+)*[a-z]?)\.?\s+(.+?)\s*$", re.M)
SECTION_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.M)
# `**Dependencies**: Feature #5 (Title)` style prose used by feature-numbered roadmaps.
FEATURE_DEP_NUM_RE = re.compile(r"[Ff]eature\s*#?\s*(\d+(?:-[a-z0-9-]+)?)\b")


def _log(log_path: Path, msg: str) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with log_path.open("a") as f:
        f.write(f"[{ts}] {msg}\n")
    print(msg)


def _read_config(config_path: Path) -> dict:
    """Tiny YAML subset parser — we only need scalar key: value pairs.

    Keeping this dependency-free so autopilot works on a bare system.
    """
    cfg: dict = {}
    if not config_path.exists():
        return cfg
    for line in config_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        # Strip inline comments
        if "#" in v and not v.startswith("'") and not v.startswith('"'):
            v = v.split("#", 1)[0].strip()
        # Coerce
        if v.lower() in {"true", "false"}:
            cfg[k.strip()] = v.lower() == "true"
        elif v.isdigit():
            cfg[k.strip()] = int(v)
        else:
            cfg[k.strip()] = v.strip("'\"")
    return cfg


def _load_claims(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text() or "{}")
    except json.JSONDecodeError:
        return {}


def _is_active_not_stale(entry: dict, now: datetime) -> bool:
    if entry.get("status") != "active":
        return False
    claimed = datetime.fromisoformat(entry["claimed_at"])
    ttl = timedelta(hours=entry.get("ttl_hours", 12))
    return (now - claimed) < ttl


def _all_phase_ids(
    roadmap_path: Path,
    feature_id_prefix: str = "",
    priority_sections: list[str] | None = None,
) -> list[tuple[str, str]]:
    """Return ordered (full_id, raw_id) pairs for every phase heading.

    `full_id` is what we look up in claims and pass to dispatch (prefix applied).
    `raw_id` is the bare number from the heading — used for roadmap-side lookups
    (DoD completion, dependency cross-references).

    Strikethrough headings (`### 10. ~~Title~~`) are skipped — the roadmap uses
    them to mark features merged into another. `priority_sections`, when set,
    restricts the result to features under the named `## Priority: …` blocks.
    """
    text = roadmap_path.read_text()
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    current_section: str | None = None
    for line in text.splitlines():
        sm = SECTION_HEADING_RE.match(line)
        if sm:
            current_section = sm.group(1).strip()
            continue
        m = PHASE_HEADING_RE.match(line)
        if not m:
            continue
        if priority_sections and current_section not in priority_sections:
            continue
        raw_id = m.group(1)
        title = m.group(2).strip()
        # `~~Title~~` marks a feature that has been merged elsewhere — skip it.
        if title.startswith("~~"):
            continue
        full_id = f"{feature_id_prefix}{raw_id}" if feature_id_prefix else raw_id
        if full_id in seen:
            continue
        seen.add(full_id)
        out.append((full_id, raw_id))
    return out


def _phase_section_text(roadmap_path: Path, raw_id: str) -> str | None:
    """Return the body of a feature section keyed by raw heading id, or None."""
    text = roadmap_path.read_text()
    lines = text.splitlines()
    heading_re = re.compile(rf"^###\s+{re.escape(raw_id)}\.?\s+")
    start = None
    for i, ln in enumerate(lines):
        if heading_re.match(ln):
            start = i
            break
    if start is None:
        return None
    end = start + 1
    while end < len(lines):
        ln = lines[end]
        if ln.startswith("### ") or ln.startswith("## ") or ln.startswith("# "):
            break
        end += 1
    return "\n".join(lines[start:end])


def _roadmap_dod_complete(roadmap_path: Path, raw_id: str) -> bool:
    """A feature counts as roadmap-complete when every checkbox under its
    section is ticked. Sections with zero checkboxes don't qualify — we want
    explicit DoD evidence, not an absence of one.
    """
    section = _phase_section_text(roadmap_path, raw_id)
    if section is None:
        return False
    checked = len(re.findall(r"\[[xX]\]", section))
    unchecked = len(re.findall(r"\[ \]", section))
    if checked == 0 and unchecked == 0:
        return False
    return unchecked == 0


def _roadmap_prose_deps(
    roadmap_path: Path, raw_id: str, feature_id_prefix: str
) -> list[str]:
    """Extract dependencies from a `**Dependencies**: …` bullet on this feature.

    Used by feature-numbered roadmaps that don't go through `phased_roadmap_parser`.
    `Dependencies: None` (or any line whose first word is None) yields no deps.
    Otherwise every `Feature #N` (or `feature N-suffix`) reference becomes a dep.
    """
    if not feature_id_prefix:
        return []
    section = _phase_section_text(roadmap_path, raw_id)
    if section is None:
        return []
    m = re.search(r"\*\*Dependencies\*\*\s*:\s*(.+)", section)
    if not m:
        return []
    line = m.group(1).strip()
    # Stop at the next bullet so we don't slurp later prose
    line = line.split("\n- ")[0]
    if line.lower().startswith("none"):
        return []
    deps: list[str] = []
    seen: set[str] = set()
    for fm in FEATURE_DEP_NUM_RE.finditer(line):
        dep = f"{feature_id_prefix}{fm.group(1)}"
        if dep in seen:
            continue
        seen.add(dep)
        deps.append(dep)
    return deps


def _dep_satisfied(
    claims: dict, dep_id: str, roadmap_path: Path, feature_id_prefix: str
) -> bool:
    """A dep is met if the claim is `completed` OR the roadmap shows full DoD."""
    if claims.get(dep_id, {}).get("status") == "completed":
        return True
    if not feature_id_prefix or not dep_id.startswith(feature_id_prefix):
        return False
    raw_dep = dep_id[len(feature_id_prefix):]
    return _roadmap_dod_complete(roadmap_path, raw_dep)


def _phase_deps(phase_id: str, repo_root: Path, parser_script: Path) -> list[str]:
    try:
        out = subprocess.run(
            [
                sys.executable,
                str(parser_script),
                phase_id,
                "--repo-root",
                str(repo_root),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        return json.loads(out.stdout).get("depends_on", []) or []
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return []


def _effective_deps(phase_id: str, explicit: list[str], all_phases: list[str]) -> list[str]:
    """Apply the major-phase-ordering rule on top of explicit deps.

    A phase N.x with N > 0 implicitly depends on ALL M.y phases where M < N.
    This matches the roadmap's dependency graph (Phase 1 requires Phase 0, etc.)
    without requiring every sub-phase to declare its transitive deps inline.

    Safe by default: if the roadmap wants to allow a phase to jump ahead of
    this rule, declare it explicitly via a "Depends on: []" override in the
    phase section (not yet implemented — add if needed).
    """
    if "." not in phase_id:
        return explicit
    try:
        major = int(phase_id.split(".")[0])
    except ValueError:
        return explicit
    if major == 0:
        return explicit
    implicit = [
        p for p in all_phases
        if "." in p and _major(p) is not None and _major(p) < major  # type: ignore[operator]
    ]
    return sorted(set(explicit) | set(implicit))


def _major(phase_id: str) -> int | None:
    try:
        return int(phase_id.split(".")[0])
    except ValueError:
        return None


def _dispatch(repo_root: Path, phase_id: str, log_dir: Path) -> subprocess.Popen:
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"autopilot-{phase_id}.log"
    # Detached claude -p session. Using stdbuf so logs are line-buffered.
    # stdin is /dev/null so the session never waits on us.
    cmd = ["claude", "-p", f"Run /roadmap work {phase_id}"]
    with open(log_file, "ab") as lf, open(os.devnull, "rb") as devnull:
        proc = subprocess.Popen(
            cmd,
            cwd=str(repo_root),
            stdin=devnull,
            stdout=lf,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # detach; survives parent exit
        )
    return proc


# Failure-counter file schema:
#   {fid: {"count": N, "last_seen_released_at": ISO-or-null}}
# Older versions wrote {fid: N} (bare int); we accept either on read and
# rewrite in the new shape on the next bump.

def _read_failures(claims_path: Path) -> dict:
    counters_path = claims_path.parent / "roadmap-failures.json"
    if not counters_path.exists():
        return {}
    try:
        raw = json.loads(counters_path.read_text() or "{}")
    except json.JSONDecodeError:
        return {}
    if not isinstance(raw, dict):
        return {}
    # Migrate flat-int shape to dict shape in memory; persisted on next write.
    out: dict = {}
    for fid, val in raw.items():
        if isinstance(val, dict):
            out[fid] = val
        elif isinstance(val, int):
            out[fid] = {"count": val, "last_seen_released_at": None}
    return out


def _write_failures(claims_path: Path, counters: dict) -> None:
    counters_path = claims_path.parent / "roadmap-failures.json"
    tmp = counters_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(counters, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, counters_path)


def _failure_count(claims_path: Path, phase_id: str) -> int:
    entry = _read_failures(claims_path).get(phase_id, {})
    return int(entry.get("count", 0))


def _increment_failures(claims_path: Path, phase_id: str,
                         released_at: str | None = None) -> int:
    """Bump the failures counter for a phase. Returns the new count.

    `released_at` lets us dedupe: when invoked for an abandoned claim, callers
    pass the claim's `released_at` so a claim that lingers in the file across
    cycles is only counted once.
    """
    counters = _read_failures(claims_path)
    entry = counters.get(phase_id, {"count": 0, "last_seen_released_at": None})
    entry["count"] = int(entry.get("count", 0)) + 1
    if released_at is not None:
        entry["last_seen_released_at"] = released_at
    counters[phase_id] = entry
    _write_failures(claims_path, counters)
    return entry["count"]


def _process_abandoned_failures(claims_path: Path, claims: dict,
                                 log_path: Path) -> int:
    """For each abandoned claim, if its `released_at` hasn't been counted yet,
    bump the failure counter. Returns the number of new failures recorded.

    This was previously a `pass # deferred` TODO — without it, abandoned
    phases retry forever because the failure ceiling never trips.
    """
    counters = _read_failures(claims_path)
    new = 0
    for fid, entry in claims.items():
        if entry.get("status") != "abandoned":
            continue
        released_at = entry.get("released_at")
        if not released_at:
            continue
        prior = counters.get(fid, {"count": 0, "last_seen_released_at": None})
        if prior.get("last_seen_released_at") == released_at:
            continue  # already counted this abandonment
        prior["count"] = int(prior.get("count", 0)) + 1
        prior["last_seen_released_at"] = released_at
        counters[fid] = prior
        new += 1
        _log(log_path,
             f"recorded failure for {fid} (count={prior['count']}, "
             f"released_at={released_at})")
    if new:
        _write_failures(claims_path, counters)
    return new


def _orchestrator_alive(phase_id: str) -> bool:
    """True if a `claude -p Run /roadmap work <phase_id>` session is currently
    running. Used by the dispatcher (NOT by the agent — the agent must not
    pgrep, see commands/roadmap.md headless rules). Errs on the safe side:
    if pgrep itself fails, returns True so we don't abandon a real claim
    based on a transient inspection failure.
    """
    try:
        out = subprocess.run(
            ["pgrep", "-f", f"claude -p Run /roadmap work {phase_id}"],
            capture_output=True, text=True, timeout=5,
        )
        return bool(out.stdout.strip())
    except Exception:  # noqa: BLE001
        return True


def _worktree_exists(repo_root: Path, phase_id: str) -> bool:
    """Both naming conventions are observed in the wild — `EnterWorktree`
    builds `feature-<id>` while `superpowers:using-git-worktrees` builds
    `feature+<id>`. Accept either."""
    base = repo_root / ".claude" / "worktrees"
    return any((base / f"feature-{phase_id}").exists()
               or (base / f"feature+{phase_id}").exists()
               for _ in [0])


def _branch_has_real_commits(repo_root: Path, phase_id: str) -> bool:
    """True if `feature/<id>` exists locally and has at least one commit
    beyond the merge-base with main. The claim commit goes to main (not the
    feature branch) so any commits on the feature branch are real work."""
    branch = f"feature/{phase_id}"
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_root), "rev-list", "--count",
             branch, "^main"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode != 0:
            return False
        return int((out.stdout or "0").strip() or 0) > 0
    except Exception:  # noqa: BLE001
        return False


def _release_abandoned(repo_root: Path, phase_id: str, session_id: str,
                        reason: str, log_path: Path) -> bool:
    """Auto-abandon a phantom claim via local_claim_ops.py so the file lock
    semantics are honoured (we don't race with another orchestrator that
    might be writing the file via fcntl)."""
    lco = Path(__file__).parent / "local_claim_ops.py"
    if not lco.exists():
        _log(log_path, f"can't auto-abandon {phase_id}: {lco} missing")
        return False
    try:
        subprocess.run(
            [sys.executable, str(lco), "release",
             "--repo", str(repo_root),
             "--feature-id", phase_id,
             "--session-id", session_id,
             "--status", "abandoned"],
            check=True, capture_output=True, text=True, timeout=15,
        )
        _log(log_path, f"auto-abandoned phantom {phase_id}: {reason}")
        return True
    except subprocess.CalledProcessError as exc:
        _log(log_path,
             f"failed to auto-abandon {phase_id}: rc={exc.returncode} "
             f"stderr={(exc.stderr or '')[:200]}")
        return False


def _check_phantom_claims(claims_path: Path, claims: dict, repo_root: Path,
                           now: datetime, no_wt_grace_min: int,
                           no_commit_grace_min: int, log_path: Path) -> int:
    """Auto-abandon active claims whose owner appears to be dead.

    Three guards must align before we abandon — we'd rather waste a slot on
    a slow agent than kill a real one prematurely:

      1. Claim age exceeds the relevant grace period.
      2. Either no worktree exists (early signal) or no real branch commits
         exist (later signal).
      3. No `claude -p Run /roadmap work <id>` process is currently running.

    Returns the number of claims abandoned.
    """
    abandoned = 0
    for fid, entry in list(claims.items()):
        if entry.get("status") != "active":
            continue
        try:
            claimed = datetime.fromisoformat(entry["claimed_at"])
        except (KeyError, ValueError, TypeError):
            continue
        age_min = (now - claimed).total_seconds() / 60

        reason: str | None = None
        if age_min > no_wt_grace_min and not _worktree_exists(repo_root, fid):
            reason = (f"no worktree after {age_min:.0f}m "
                      f"(>{no_wt_grace_min}m grace)")
        elif age_min > no_commit_grace_min and not _branch_has_real_commits(
                repo_root, fid):
            reason = (f"no commits on feature/{fid} after {age_min:.0f}m "
                      f"(>{no_commit_grace_min}m grace)")

        if reason is None:
            continue
        if _orchestrator_alive(fid):
            # The agent is alive but slow — leave it. The TTL still protects
            # us if it goes truly stale, and the next cycle will recheck.
            continue

        sid = entry.get("session_id") or entry.get("claimed_by") or ""
        if _release_abandoned(repo_root, fid, sid, reason, log_path):
            entry["status"] = "abandoned"
            entry["released_at"] = now.isoformat()
            abandoned += 1
    return abandoned


def _sync_roadmap_markers(repo_root: Path, log_path: Path) -> None:
    """Best-effort: shell out to local_claim_ops.py sync-from-roadmap so any
    `[Implemented — date]` markers in the roadmap become `completed` claims
    before eligibility is computed. Off by default; opt-in via flag."""
    sync_script = Path(__file__).parent / "local_claim_ops.py"
    if not sync_script.exists():
        _log(log_path, f"sync-roadmap-markers: missing {sync_script}")
        return
    try:
        out = subprocess.run(
            [sys.executable, str(sync_script), "sync-from-roadmap",
             "--repo", str(repo_root)],
            capture_output=True, text=True, timeout=30, check=True,
        )
        try:
            payload = json.loads(out.stdout or "{}")
            synced = payload.get("synced") or []
            if synced:
                _log(log_path,
                     f"sync-roadmap-markers: promoted {len(synced)} phase(s) "
                     f"from roadmap markers ({','.join(synced)})")
        except json.JSONDecodeError:
            _log(log_path, f"sync-roadmap-markers: non-JSON stdout: {out.stdout[:200]}")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        _log(log_path, f"sync-roadmap-markers: {exc!r}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=".", help="Repository root")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would dispatch but don't launch")
    ap.add_argument(
        "--sync-roadmap-markers", action="store_true",
        help="Before dispatch, promote [Implemented — date] roadmap markers "
             "to completed claims via local_claim_ops.py sync-from-roadmap. "
             "Off by default to keep claims-only as the source of truth.",
    )
    args = ap.parse_args()
    repo_root = Path(args.repo_root).resolve()
    log_path = repo_root / ".orchestrator" / "autopilot.log"

    if args.sync_roadmap_markers:
        _sync_roadmap_markers(repo_root, log_path)

    # Config
    cfg = _read_config(repo_root / ".orchestrator" / "config.yaml")
    max_parallel = int(cfg.get("MAX_PARALLEL_SESSIONS", 2))
    max_failures = int(cfg.get("MAX_PHASE_FAILURES", 3))
    no_wt_grace_min = int(cfg.get("STALE_CLAIM_NO_WORKTREE_MIN", 5))
    no_commit_grace_min = int(cfg.get("STALE_CLAIM_NO_COMMITS_MIN", 15))
    # Feature-numbered roadmap support: a non-empty prefix turns on the
    # `### N. Title` + `feature-N` claim convention. Defaults preserve the
    # phased (fabrick) behaviour.
    feature_id_prefix = str(cfg.get("FEATURE_ID_PREFIX", "") or "")
    priority_sections_raw = str(cfg.get("PRIORITY_SECTIONS", "") or "")
    priority_sections = [
        s.strip() for s in priority_sections_raw.split(",") if s.strip()
    ] or None

    # Paused?
    pause_sentinel = repo_root / ".orchestrator" / "autopilot.paused"
    if pause_sentinel.exists():
        _log(log_path, "paused — sentinel present; exiting")
        return 0

    # Load claims
    claims_path = repo_root / ".claude" / "roadmap-claims.json"
    claims = _load_claims(claims_path)
    now = datetime.now(timezone.utc)

    # Auto-recover phantom claims: an active claim whose owner died before
    # producing real work parks a slot for hours otherwise. `_check_phantom_claims`
    # mutates the in-memory `claims` dict to reflect newly-abandoned entries
    # so the same cycle can dispatch a replacement.
    if not args.dry_run:
        _check_phantom_claims(
            claims_path, claims, repo_root, now,
            no_wt_grace_min, no_commit_grace_min, log_path,
        )

    # Bump failure counters for newly-abandoned claims so phases that fail
    # repeatedly eventually trip the MAX_PHASE_FAILURES ceiling.
    if not args.dry_run:
        _process_abandoned_failures(claims_path, claims, log_path)

    # Count active, non-stale claims (after phantom cleanup)
    active_ids = [fid for fid, e in claims.items() if _is_active_not_stale(e, now)]
    active_count = len(active_ids)

    if active_count >= max_parallel:
        _log(log_path,
             f"at cap — active={active_count}/{max_parallel} ({','.join(active_ids) or '—'})")
        return 0

    slots = max_parallel - active_count

    # Determine eligible phases
    roadmap_path = repo_root / "docs" / "roadmap.md"
    parser_script = Path(__file__).parent / "phased_roadmap_parser.py"
    if not roadmap_path.exists() or not parser_script.exists():
        _log(log_path, f"missing roadmap or parser — roadmap={roadmap_path.exists()} parser={parser_script.exists()}")
        return 2

    all_phase_pairs = _all_phase_ids(
        roadmap_path,
        feature_id_prefix=feature_id_prefix,
        priority_sections=priority_sections,
    )
    all_phases = [pid for pid, _ in all_phase_pairs]

    candidates: list[str] = []
    for pid, raw_id in all_phase_pairs:
        entry = claims.get(pid, {})
        status = entry.get("status")
        if status == "completed":
            continue
        if status == "active" and _is_active_not_stale(entry, now):
            continue  # someone else is already working on it
        # Roadmap-DoD completion fallback: features without a claim row but
        # whose checkboxes are all ticked are done — don't dispatch them.
        if feature_id_prefix and _roadmap_dod_complete(roadmap_path, raw_id):
            continue
        # Failure ceiling
        fcount = _failure_count(claims_path, pid)
        if fcount >= max_failures:
            continue
        # Dependency check. The phased parser is fabrick-shaped and won't find
        # anything for feature-numbered roadmaps, so when we have a prefix we
        # also parse `**Dependencies**: Feature #N` prose. Major-phase ordering
        # remains a no-op for flat IDs (it short-circuits on no `.`).
        explicit = _phase_deps(pid, repo_root, parser_script)
        if feature_id_prefix:
            explicit = sorted(set(explicit) | set(
                _roadmap_prose_deps(roadmap_path, raw_id, feature_id_prefix)
            ))
        deps = _effective_deps(pid, explicit, all_phases)
        if not all(_dep_satisfied(claims, d, roadmap_path, feature_id_prefix)
                   for d in deps):
            continue
        candidates.append(pid)
        if len(candidates) >= slots:
            break

    if not candidates:
        _log(log_path,
             f"no eligible phases (active={active_count}, roadmap_phases={len(all_phases)})")
        return 0

    if args.dry_run:
        _log(log_path, f"dry-run — would dispatch: {','.join(candidates)}")
        return 0

    # Dispatch
    log_dir = repo_root / ".orchestrator"
    for pid in candidates:
        try:
            proc = _dispatch(repo_root, pid, log_dir)
            _log(log_path,
                 f"dispatched {pid} (pid={proc.pid}) → .orchestrator/autopilot-{pid}.log")
        except Exception as exc:  # noqa: BLE001
            _log(log_path, f"dispatch failed for {pid}: {exc}")
            _increment_failures(claims_path, pid)

    _log(log_path,
         f"autopilot cycle complete — dispatched {len(candidates)} "
         f"(active before={active_count}, cap={max_parallel})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

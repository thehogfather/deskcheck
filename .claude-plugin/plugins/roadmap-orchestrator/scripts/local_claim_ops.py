#!/usr/bin/env python3
"""Local-only claim coordination for parallel orchestrator sessions.

Serialises read-modify-write of .claude/roadmap-claims.json via an fcntl
exclusive lock on .git/fabric-claims.lock. Commits to local main; never pushes.

Designed for the orchestrator when LOCAL_ONLY=true. Drop-in replacement for the
subset of roadmap_ops.py commands the orchestrator calls in local mode:
  claim, release, list, sync-from-roadmap.

Usage:
  local_claim_ops.py claim   --repo <path> --feature-id <id> --session-id <id> [--ttl-hours N]
  local_claim_ops.py release --repo <path> --feature-id <id> --session-id <id> [--status STATUS]
  local_claim_ops.py list    --repo <path> [--status active|completed|abandoned]
  local_claim_ops.py sync-from-roadmap --repo <path> [--roadmap docs/roadmap.md]

Output: JSON to stdout. Exit 0 on success (including {ok: false} conflicts).
Exit non-zero only on unexpected errors (missing repo, git failure, etc.).
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Matches a phased roadmap heading with an optional [Implemented — date]
# completion marker, e.g.:
#   ### 0.1a Identity — OIDC + JWT + dev mode **[Implemented — 2026-04-24]**
# Group 1: phase id (0.1a, 1.2c, ...)
# Group 2: ISO-ish date string after "Implemented —" (or "Implemented -")
_IMPLEMENTED_HEADING_RE = re.compile(
    r"^###\s+(\d+(?:\.\d+)*[a-z]?)\s+.*?"
    r"\*\*\[Implemented\s*[—-]\s*(\d{4}-\d{2}-\d{2})\]\*\*",
    re.M,
)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _claims_path(repo: Path) -> Path:
    return repo / ".claude" / "roadmap-claims.json"


def _lock_path(repo: Path) -> Path:
    return repo / ".git" / "fabric-claims.lock"


@contextmanager
def _lock(repo: Path):
    lp = _lock_path(repo)
    lp.parent.mkdir(parents=True, exist_ok=True)
    # Open for read+write without truncation so contenders share the same inode
    fd = os.open(str(lp), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _load_claims(repo: Path) -> dict:
    p = _claims_path(repo)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text() or "{}")
    except json.JSONDecodeError:
        # Corrupt file — fail loud rather than silently overwrite
        raise SystemExit(f"Corrupt claims file: {p}")


def _write_claims_atomic(repo: Path, claims: dict) -> None:
    p = _claims_path(repo)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(claims, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, p)


def _git_commit(repo: Path, message: str) -> str:
    # Stage only the claims file
    subprocess.run(
        ["git", "-C", str(repo), "add", ".claude/roadmap-claims.json"],
        check=True,
        capture_output=True,
    )
    # Allow empty-diff commits to be a no-op rather than an error
    diff = subprocess.run(
        ["git", "-C", str(repo), "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if diff.returncode == 0:
        # Nothing staged — claim state unchanged
        sha = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        return sha
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-m", message],
        check=True,
        capture_output=True,
    )
    sha = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return sha


def _is_active(entry: dict, now: datetime) -> bool:
    if entry.get("status") != "active":
        return False
    claimed_at = datetime.fromisoformat(entry["claimed_at"])
    ttl = timedelta(hours=entry.get("ttl_hours", 24))
    return (now - claimed_at) < ttl


def cmd_claim(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    now = datetime.now(timezone.utc)
    with _lock(repo):
        claims = _load_claims(repo)
        existing = claims.get(args.feature_id)
        if existing and _is_active(existing, now) and existing["session_id"] != args.session_id:
            print(json.dumps({
                "ok": False,
                "reason": "claimed",
                "by": existing["session_id"],
                "claimed_at": existing["claimed_at"],
            }, indent=2))
            return 0
        claims[args.feature_id] = {
            "session_id": args.session_id,
            "claimed_at": _utcnow_iso(),
            "ttl_hours": args.ttl_hours,
            "status": "active",
        }
        _write_claims_atomic(repo, claims)
        sha = _git_commit(repo, f"chore: claim {args.feature_id} for orchestration")
        print(json.dumps({
            "ok": True,
            "feature_id": args.feature_id,
            "session_id": args.session_id,
            "commit": sha,
        }, indent=2))
        return 0


def cmd_release(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    with _lock(repo):
        claims = _load_claims(repo)
        entry = claims.get(args.feature_id)
        if not entry:
            print(json.dumps({"ok": False, "reason": "no_claim"}, indent=2))
            return 0
        if entry.get("session_id") != args.session_id and entry.get("status") == "active":
            # Releasing someone else's active claim only allowed with --force
            if not args.force:
                print(json.dumps({
                    "ok": False,
                    "reason": "owned_by_other_session",
                    "owner": entry.get("session_id"),
                }, indent=2))
                return 0
        entry.update({
            "status": args.status,
            "released_at": _utcnow_iso(),
            "released_by": args.session_id,
        })
        claims[args.feature_id] = entry
        _write_claims_atomic(repo, claims)
        sha = _git_commit(
            repo,
            f"chore: release claim on {args.feature_id} ({args.status})",
        )
        print(json.dumps({"ok": True, "commit": sha, "status": args.status}, indent=2))
        return 0


def _parse_implemented_markers(roadmap_text: str) -> list[tuple[str, str]]:
    """Return [(phase_id, date_str), ...] for every heading bearing an
    [Implemented — YYYY-MM-DD] marker. Order preserved, duplicates kept
    (callers dedupe by phase_id)."""
    return [(m.group(1), m.group(2)) for m in _IMPLEMENTED_HEADING_RE.finditer(roadmap_text)]


def cmd_sync_from_roadmap(args: argparse.Namespace) -> int:
    """Promote `[Implemented — date]` roadmap markers into completed claims.

    For each marker the phase id of which is not yet present (or is present
    but not in `completed`/`active` status), write a completed claim with
    session_id `roadmap-sync-<date>`. Refuses to clobber an active claim —
    that case is reported in `skipped_active`. Idempotent: a second run
    against the same roadmap produces no changes and no commit.
    """
    repo = Path(args.repo).resolve()
    roadmap_path = (repo / args.roadmap).resolve() if not Path(args.roadmap).is_absolute() else Path(args.roadmap)
    if not roadmap_path.exists():
        print(json.dumps({"ok": False, "reason": "roadmap_not_found",
                          "path": str(roadmap_path)}, indent=2))
        return 1
    roadmap_text = roadmap_path.read_text()
    markers = _parse_implemented_markers(roadmap_text)

    synced: list[str] = []
    skipped_active: list[str] = []
    already_completed: list[str] = []

    with _lock(repo):
        claims = _load_claims(repo)
        seen: set[str] = set()
        for phase_id, date_str in markers:
            if phase_id in seen:
                continue
            seen.add(phase_id)
            existing = claims.get(phase_id)
            if existing and existing.get("status") == "completed":
                already_completed.append(phase_id)
                continue
            if existing and existing.get("status") == "active":
                # Don't clobber a live session — let it finish or stale out.
                skipped_active.append(phase_id)
                continue
            ts = f"{date_str}T00:00:00+00:00"
            claims[phase_id] = {
                "feature_id": phase_id,
                "session_id": f"roadmap-sync-{date_str}",
                "claimed_at": ts,
                "released_at": ts,
                "released_by": "roadmap-sync",
                "status": "completed",
                "ttl_hours": 24,
            }
            synced.append(phase_id)

        commit_sha: str | None = None
        if synced:
            _write_claims_atomic(repo, claims)
            commit_sha = _git_commit(
                repo,
                f"chore: sync {len(synced)} completed phase(s) from roadmap markers",
            )

    print(json.dumps({
        "ok": True,
        "synced": synced,
        "skipped_active": skipped_active,
        "already_completed": already_completed,
        "commit": commit_sha,
    }, indent=2))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    now = datetime.now(timezone.utc)
    with _lock(repo):
        claims = _load_claims(repo)
    out = []
    for fid, entry in sorted(claims.items()):
        rec = {"feature_id": fid, **entry}
        if entry.get("status") == "active":
            rec["is_stale"] = not _is_active(entry, now)
        if args.status and entry.get("status") != args.status:
            continue
        out.append(rec)
    print(json.dumps(out, indent=2))
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("claim")
    pc.add_argument("--repo", required=True)
    pc.add_argument("--feature-id", required=True)
    pc.add_argument("--session-id", required=True)
    pc.add_argument("--ttl-hours", type=int, default=24)
    pc.set_defaults(func=cmd_claim)

    pr = sub.add_parser("release")
    pr.add_argument("--repo", required=True)
    pr.add_argument("--feature-id", required=True)
    pr.add_argument("--session-id", required=True)
    pr.add_argument("--status", default="completed",
                    choices=["completed", "abandoned"])
    pr.add_argument("--force", action="store_true",
                    help="release a claim held by another session")
    pr.set_defaults(func=cmd_release)

    pl = sub.add_parser("list")
    pl.add_argument("--repo", required=True)
    pl.add_argument("--status", default=None,
                    choices=["active", "completed", "abandoned"])
    pl.set_defaults(func=cmd_list)

    ps = sub.add_parser(
        "sync-from-roadmap",
        help="Promote [Implemented — date] roadmap markers into completed claims",
    )
    ps.add_argument("--repo", required=True)
    ps.add_argument("--roadmap", default="docs/roadmap.md",
                    help="Roadmap file relative to --repo (default: docs/roadmap.md)")
    ps.set_defaults(func=cmd_sync_from_roadmap)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

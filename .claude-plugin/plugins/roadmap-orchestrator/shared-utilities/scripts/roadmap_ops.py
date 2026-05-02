#!/usr/bin/env python3
"""
Standardized roadmap operations for Claude Code workflows.

Usage:
    python3 roadmap_ops.py find-feature <roadmap-file> <feature-id>
    python3 roadmap_ops.py update-checkbox <roadmap-file> <task-text> done|undone
    python3 roadmap_ops.py calculate-progress <roadmap-file> [feature-id]
    python3 roadmap_ops.py list-features <roadmap-file> [--priority=now|next|later]
    python3 roadmap_ops.py extract-dod <roadmap-file> <feature-id>
    python3 roadmap_ops.py claim-feature <roadmap-file> <feature-id> <session-id> [--claims-file] [--ttl-hours]
    python3 roadmap_ops.py release-claim <feature-id> <session-id> [--claims-file] [--status=completed|abandoned]
    python3 roadmap_ops.py list-claims [--claims-file] [--status=active]
"""

import os
import re
import sys
import json
import argparse
from datetime import datetime, timezone
from pathlib import Path
from dataclasses import dataclass, asdict, field
from typing import Optional, List

DEFAULT_CLAIMS_FILE = '.claude/roadmap-claims.json'
DEFAULT_CLAIM_TTL_HOURS = 24
PRUNE_COMPLETED_DAYS = 90

# Bare-integer feature IDs (legacy team-mode roadmaps where features are
# numbered "1", "2", "25", ...) get an automatic "feature-" prefix so that
# the dict key matches the title that find_feature parses out of the
# roadmap. Phased IDs ("0.1a", "1.2c", ...) are passed through unchanged
# so they line up with what local_claim_ops.py and autopilot.py write.
_BARE_INTEGER_ID = re.compile(r'^\d+$')


@dataclass
class Task:
    text: str
    done: bool
    line_number: int


@dataclass
class Feature:
    id: str
    title: str
    priority: str
    persona: Optional[str] = None
    goal: Optional[str] = None
    impact: Optional[str] = None
    effort: Optional[str] = None
    tasks: List[Task] = field(default_factory=list)
    start_line: int = 0
    end_line: int = 0

    @property
    def progress(self) -> float:
        if not self.tasks:
            return 0.0
        done = sum(1 for t in self.tasks if t.done)
        return (done / len(self.tasks)) * 100


def parse_roadmap(content: str) -> List[Feature]:
    """Parse roadmap markdown into structured data."""
    features = []
    current_priority = "unknown"
    current_feature = None
    lines = content.split('\n')

    priority_pattern = re.compile(r'^##\s+Priority:\s*(\w+)', re.IGNORECASE)
    feature_pattern = re.compile(r'^###\s+(?:Feature\s+)?(\d+)?\.?\s*(.+)', re.IGNORECASE)
    task_pattern = re.compile(r'^\s*-\s*\[([ xX])\]\s*(.+)')
    persona_pattern = re.compile(r'\*\*Persona\*\*:\s*(.+)', re.IGNORECASE)
    goal_pattern = re.compile(r'\*\*Goal\*\*:\s*(.+)', re.IGNORECASE)
    impact_pattern = re.compile(r'\*\*Impact\*\*:\s*(\w+)', re.IGNORECASE)
    effort_pattern = re.compile(r'\*\*Effort\*\*:\s*(\w+)', re.IGNORECASE)

    for i, line in enumerate(lines):
        # Check for priority section
        priority_match = priority_pattern.match(line)
        if priority_match:
            current_priority = priority_match.group(1).lower()
            continue

        # Check for feature header
        feature_match = feature_pattern.match(line)
        if feature_match:
            # Save previous feature
            if current_feature:
                current_feature.end_line = i - 1
                features.append(current_feature)

            feature_num = feature_match.group(1) or str(len(features) + 1)
            title = feature_match.group(2).strip()
            # Clean up title (remove trailing parenthetical notes like "(Low Priority)")
            clean_title = re.sub(r'\s*\([^)]*\)\s*$', '', title)

            current_feature = Feature(
                id=f'feature-{feature_num}',
                title=clean_title,
                priority=current_priority,
                start_line=i,
            )
            continue

        if current_feature:
            # Check for metadata
            if persona_match := persona_pattern.search(line):
                current_feature.persona = persona_match.group(1).strip()
            elif goal_match := goal_pattern.search(line):
                current_feature.goal = goal_match.group(1).strip()
            elif impact_match := impact_pattern.search(line):
                current_feature.impact = impact_match.group(1).strip()
            elif effort_match := effort_pattern.search(line):
                current_feature.effort = effort_match.group(1).strip()

            # Check for task
            task_match = task_pattern.match(line)
            if task_match:
                current_feature.tasks.append(Task(
                    text=task_match.group(2).strip(),
                    done=task_match.group(1).lower() == 'x',
                    line_number=i
                ))

    # Don't forget last feature
    if current_feature:
        current_feature.end_line = len(lines) - 1
        features.append(current_feature)

    return features


def find_feature(roadmap_path: str, feature_id: str) -> Optional[dict]:
    """Find a specific feature by ID."""
    content = Path(roadmap_path).read_text()
    features = parse_roadmap(content)

    # Normalize feature ID
    if not feature_id.startswith('feature-'):
        feature_id = f'feature-{feature_id}'

    for feature in features:
        if feature.id == feature_id:
            result = asdict(feature)
            result['progress'] = feature.progress
            return result
    return None


def update_checkbox(roadmap_path: str, task_text: str, done: bool) -> dict:
    """Update a checkbox in the roadmap file."""
    path = Path(roadmap_path)
    content = path.read_text()
    lines = content.split('\n')

    # Escape special regex characters in task text
    escaped_text = re.escape(task_text)
    pattern = re.compile(rf'^(\s*-\s*\[)[ xX](\]\s*{escaped_text})', re.IGNORECASE)

    updated = False
    line_number = -1
    for i, line in enumerate(lines):
        if pattern.match(line):
            checkbox = 'x' if done else ' '
            lines[i] = pattern.sub(rf'\g<1>{checkbox}\g<2>', line)
            updated = True
            line_number = i
            break

    if updated:
        path.write_text('\n'.join(lines))
        return {
            'success': True,
            'task': task_text,
            'done': done,
            'line_number': line_number
        }
    else:
        return {
            'success': False,
            'error': f'Task not found: {task_text}',
            'hint': 'Task text must match exactly (case-insensitive)'
        }


def calculate_progress(roadmap_path: str, feature_id: Optional[str] = None) -> dict:
    """Calculate progress for a feature or entire roadmap."""
    content = Path(roadmap_path).read_text()
    features = parse_roadmap(content)

    if feature_id:
        if not feature_id.startswith('feature-'):
            feature_id = f'feature-{feature_id}'
        for feature in features:
            if feature.id == feature_id:
                done_tasks = sum(1 for t in feature.tasks if t.done)
                return {
                    'feature_id': feature.id,
                    'title': feature.title,
                    'total_tasks': len(feature.tasks),
                    'done_tasks': done_tasks,
                    'progress_percent': round(feature.progress, 1)
                }
        return {'error': f'Feature {feature_id} not found'}

    # Calculate overall progress
    total_tasks = sum(len(f.tasks) for f in features)
    done_tasks = sum(sum(1 for t in f.tasks if t.done) for f in features)

    by_priority = {}
    for feature in features:
        if feature.priority not in by_priority:
            by_priority[feature.priority] = {'total': 0, 'done': 0, 'features': []}
        by_priority[feature.priority]['total'] += len(feature.tasks)
        by_priority[feature.priority]['done'] += sum(1 for t in feature.tasks if t.done)
        by_priority[feature.priority]['features'].append({
            'id': feature.id,
            'title': feature.title,
            'progress': round(feature.progress, 1)
        })

    return {
        'total_tasks': total_tasks,
        'done_tasks': done_tasks,
        'progress_percent': round((done_tasks / total_tasks * 100) if total_tasks > 0 else 0, 1),
        'by_priority': by_priority
    }


def list_features(roadmap_path: str, priority: Optional[str] = None) -> List[dict]:
    """List features, optionally filtered by priority."""
    content = Path(roadmap_path).read_text()
    features = parse_roadmap(content)

    if priority:
        features = [f for f in features if f.priority == priority.lower()]

    result = []
    for f in features:
        item = asdict(f)
        item['progress'] = round(f.progress, 1)
        result.append(item)
    return result


def extract_dod(roadmap_path: str, feature_id: str) -> List[dict]:
    """Extract Definition of Done tasks for a feature."""
    feature = find_feature(roadmap_path, feature_id)
    if not feature:
        return []
    return feature.get('tasks', [])


def _normalize_feature_id(feature_id: str) -> str:
    """Prefix bare-integer IDs with 'feature-'; pass everything else through.

    Legacy team-mode roadmaps numbered features as "1", "2", "25". Phased
    roadmaps use "0.1a", "1.2c". Both must coexist as keys in the unified
    flat-dict claims file.
    """
    if _BARE_INTEGER_ID.match(feature_id):
        return f'feature-{feature_id}'
    return feature_id


def _load_claims_dict(claims_file: str) -> dict:
    """Read claims file as a flat dict keyed by feature_id.

    Accepts both the legacy versioned shape ({"version": 1, "claims": [...]})
    and the unified flat-dict shape ({"<id>": {...}}). Returns {} if missing.
    On legacy detection, prints a one-time stderr notice; the next write
    will rewrite the file in the unified shape (no separate migration step).
    """
    path = Path(claims_file)
    if not path.exists():
        return {}
    raw = json.loads(path.read_text() or '{}')
    if isinstance(raw, dict) and 'claims' in raw and isinstance(raw['claims'], list):
        # Legacy versioned shape — migrate to flat dict in memory.
        if not os.environ.get('ROADMAP_OPS_QUIET_MIGRATION'):
            print(
                f"[roadmap_ops] migrating {claims_file} from versioned "
                f"to flat-dict format on next write",
                file=sys.stderr,
            )
        flat: dict = {}
        for c in raw['claims']:
            fid = c.get('feature_id')
            if not fid:
                continue
            entry = dict(c)
            # claimed_by → session_id (keep both during transition)
            if 'claimed_by' in entry and 'session_id' not in entry:
                entry['session_id'] = entry['claimed_by']
            flat[fid] = entry
        return flat
    if isinstance(raw, dict):
        # Already flat-dict shape. Backfill session_id from claimed_by where
        # only the legacy field is present so downstream code is uniform.
        for fid, entry in raw.items():
            if isinstance(entry, dict):
                if 'claimed_by' in entry and 'session_id' not in entry:
                    entry['session_id'] = entry['claimed_by']
        return raw
    raise ValueError(f'Unrecognised claims file shape in {claims_file}')


def _write_claims_atomic(claims_file: str, claims: dict) -> None:
    """Atomically write the flat-dict claims file."""
    path = Path(claims_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(claims, indent=2, sort_keys=True) + '\n')
    os.replace(tmp, path)


def _is_claim_stale(claim: dict, ttl_hours: int) -> bool:
    """Check if a claim is stale based on TTL."""
    if claim.get('status') != 'active':
        return False
    claimed_at = datetime.fromisoformat(claim['claimed_at'])
    age_hours = (datetime.now(timezone.utc) - claimed_at).total_seconds() / 3600
    return age_hours > ttl_hours


def _new_claim_record(feature_id: str, feature_title: str, session_id: str,
                      now: datetime, ttl_hours: int) -> dict:
    """Build a new claim record. Writes both session_id and claimed_by during
    the deprecation window so external readers expecting the old field name
    still work."""
    return {
        'feature_id': feature_id,
        'feature_title': feature_title,
        'session_id': session_id,
        'claimed_by': session_id,  # deprecated alias — drop in next major
        'claimed_at': now.isoformat(),
        'branch': f'feature/{feature_id}',
        'status': 'active',
        'ttl_hours': ttl_hours,
    }


def claim_feature(roadmap_file: str, feature_id: str, session_id: str,
                  claims_file: str = DEFAULT_CLAIMS_FILE,
                  ttl_hours: int = DEFAULT_CLAIM_TTL_HOURS) -> dict:
    """Claim a feature for a session. Returns success/failure."""
    feature_id = _normalize_feature_id(feature_id)

    # Look up feature title from roadmap (best-effort)
    feature_title = feature_id
    try:
        feature = find_feature(roadmap_file, feature_id)
        if feature:
            feature_title = feature.get('title', feature_id)
    except FileNotFoundError:
        pass

    claims = _load_claims_dict(claims_file)
    now = datetime.now(timezone.utc)

    # Auto-reap stale active claims
    for fid, entry in claims.items():
        if entry.get('status') == 'active' and _is_claim_stale(entry, ttl_hours):
            entry['status'] = 'stale_reaped'
            entry['reaped_at'] = now.isoformat()

    # Prune completed/abandoned claims older than PRUNE_COMPLETED_DAYS
    cutoff = now.timestamp() - (PRUNE_COMPLETED_DAYS * 86400)
    claims = {
        fid: entry
        for fid, entry in claims.items()
        if entry.get('status') in ('active', 'stale_reaped')
        or datetime.fromisoformat(entry['claimed_at']).timestamp() > cutoff
    }

    # Conflict check — only an active (non-stale) claim blocks
    existing = claims.get(feature_id)
    if existing and existing.get('status') == 'active':
        return {
            'success': False,
            'error': 'already_claimed',
            'claimed_by': existing.get('session_id') or existing.get('claimed_by'),
            'claimed_at': existing.get('claimed_at'),
            'feature_id': feature_id,
        }

    new_claim = _new_claim_record(feature_id, feature_title, session_id, now, ttl_hours)
    claims[feature_id] = new_claim
    _write_claims_atomic(claims_file, claims)

    return {
        'success': True,
        'feature_id': feature_id,
        'feature_title': feature_title,
        'session_id': session_id,
        'branch': new_claim['branch'],
        'claims_file': claims_file,
    }


def release_claim(feature_id: str, session_id: str,
                  claims_file: str = DEFAULT_CLAIMS_FILE,
                  status: str = 'completed') -> dict:
    """Release a claim on a feature."""
    feature_id = _normalize_feature_id(feature_id)
    claims = _load_claims_dict(claims_file)
    entry = claims.get(feature_id)

    if (
        entry
        and entry.get('status') == 'active'
        and (entry.get('session_id') == session_id or entry.get('claimed_by') == session_id)
    ):
        entry['status'] = status
        entry['released_at'] = datetime.now(timezone.utc).isoformat()
        entry['released_by'] = session_id
        _write_claims_atomic(claims_file, claims)
        return {
            'success': True,
            'feature_id': feature_id,
            'session_id': session_id,
            'new_status': status,
        }

    return {
        'success': False,
        'error': 'claim_not_found',
        'feature_id': feature_id,
        'session_id': session_id,
    }


def list_claims(claims_file: str = DEFAULT_CLAIMS_FILE,
                status_filter: Optional[str] = None,
                ttl_hours: int = DEFAULT_CLAIM_TTL_HOURS) -> List[dict]:
    """List claims, optionally filtered by status.

    Returns a list of claim records (one per feature) so existing consumers
    that pipe `list-claims` JSON into `jq '.[]'` keep working after the
    on-disk shape converged to a flat dict.
    """
    claims = _load_claims_dict(claims_file)
    result = []
    for fid, entry in sorted(claims.items()):
        if status_filter and entry.get('status') != status_filter:
            continue
        record = dict(entry)
        record.setdefault('feature_id', fid)
        record['is_stale'] = _is_claim_stale(entry, ttl_hours)
        result.append(record)
    return result


def main():
    parser = argparse.ArgumentParser(
        description='Roadmap operations utility',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s find-feature ./roadmap.md 25
  %(prog)s update-checkbox ./roadmap.md "Implement auth flow" done
  %(prog)s calculate-progress ./roadmap.md
  %(prog)s list-features ./roadmap.md --priority=now
  %(prog)s extract-dod ./roadmap.md feature-25
  %(prog)s claim-feature ./roadmap.md feature-25 session-abc123
  %(prog)s release-claim feature-25 session-abc123 --status=completed
  %(prog)s list-claims --status=active
        """
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    # find-feature
    p_find = subparsers.add_parser('find-feature', help='Find a feature by ID')
    p_find.add_argument('roadmap_file', help='Path to roadmap markdown file')
    p_find.add_argument('feature_id', help='Feature ID (e.g., 25 or feature-25)')

    # update-checkbox
    p_update = subparsers.add_parser('update-checkbox', help='Update a task checkbox')
    p_update.add_argument('roadmap_file', help='Path to roadmap markdown file')
    p_update.add_argument('task_text', help='Exact text of the task to update')
    p_update.add_argument('state', choices=['done', 'undone'], help='New checkbox state')

    # calculate-progress
    p_progress = subparsers.add_parser('calculate-progress', help='Calculate progress')
    p_progress.add_argument('roadmap_file', help='Path to roadmap markdown file')
    p_progress.add_argument('feature_id', nargs='?', help='Optional: specific feature ID')

    # list-features
    p_list = subparsers.add_parser('list-features', help='List all features')
    p_list.add_argument('roadmap_file', help='Path to roadmap markdown file')
    p_list.add_argument('--priority', choices=['now', 'next', 'later', 'share'],
                        help='Filter by priority')

    # extract-dod
    p_dod = subparsers.add_parser('extract-dod', help='Extract Definition of Done tasks')
    p_dod.add_argument('roadmap_file', help='Path to roadmap markdown file')
    p_dod.add_argument('feature_id', help='Feature ID')

    # claim-feature
    p_claim = subparsers.add_parser('claim-feature', help='Claim a feature for a session')
    p_claim.add_argument('roadmap_file', help='Path to roadmap markdown file')
    p_claim.add_argument('feature_id', help='Feature ID (e.g., 25 or feature-25)')
    p_claim.add_argument('session_id', help='Unique session identifier')
    p_claim.add_argument('--claims-file', default=DEFAULT_CLAIMS_FILE,
                         help=f'Path to claims JSON file (default: {DEFAULT_CLAIMS_FILE})')
    p_claim.add_argument('--ttl-hours', type=int, default=DEFAULT_CLAIM_TTL_HOURS,
                         help=f'Hours before inactive claim is stale (default: {DEFAULT_CLAIM_TTL_HOURS})')

    # release-claim
    p_release = subparsers.add_parser('release-claim', help='Release a claim on a feature')
    p_release.add_argument('feature_id', help='Feature ID (e.g., 25 or feature-25)')
    p_release.add_argument('session_id', help='Session that owns the claim')
    p_release.add_argument('--claims-file', default=DEFAULT_CLAIMS_FILE,
                           help=f'Path to claims JSON file (default: {DEFAULT_CLAIMS_FILE})')
    p_release.add_argument('--status', choices=['completed', 'abandoned'], default='completed',
                           help='Release status (default: completed)')

    # list-claims
    p_claims = subparsers.add_parser('list-claims', help='List active claims')
    p_claims.add_argument('--claims-file', default=DEFAULT_CLAIMS_FILE,
                          help=f'Path to claims JSON file (default: {DEFAULT_CLAIMS_FILE})')
    p_claims.add_argument('--status', dest='claim_status', default='active',
                          help='Filter by status (default: active)')
    p_claims.add_argument('--ttl-hours', type=int, default=DEFAULT_CLAIM_TTL_HOURS,
                          help=f'Hours before inactive claim is stale (default: {DEFAULT_CLAIM_TTL_HOURS})')

    args = parser.parse_args()

    try:
        if args.command == 'find-feature':
            result = find_feature(args.roadmap_file, args.feature_id)
            if result is None:
                result = {'error': f'Feature {args.feature_id} not found'}
        elif args.command == 'update-checkbox':
            result = update_checkbox(args.roadmap_file, args.task_text, args.state == 'done')
        elif args.command == 'calculate-progress':
            result = calculate_progress(args.roadmap_file, args.feature_id)
        elif args.command == 'list-features':
            result = list_features(args.roadmap_file, args.priority)
        elif args.command == 'extract-dod':
            result = extract_dod(args.roadmap_file, args.feature_id)
        elif args.command == 'claim-feature':
            result = claim_feature(
                args.roadmap_file, args.feature_id, args.session_id,
                claims_file=args.claims_file, ttl_hours=args.ttl_hours
            )
        elif args.command == 'release-claim':
            result = release_claim(
                args.feature_id, args.session_id,
                claims_file=args.claims_file, status=args.status
            )
        elif args.command == 'list-claims':
            result = list_claims(
                claims_file=args.claims_file,
                status_filter=args.claim_status,
                ttl_hours=args.ttl_hours
            )

        print(json.dumps(result, indent=2, default=str))
    except FileNotFoundError as e:
        print(json.dumps({'error': f'File not found: {e.filename}'}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()

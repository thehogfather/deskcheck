"""Tests for local_claim_ops.py sync-from-roadmap and autopilot integration.

Covers:
  - Marker parser extracts the right (phase_id, date) pairs.
  - Sync promotes markers to completed claims.
  - Sync is idempotent (no second commit).
  - Sync refuses to clobber an existing active claim.
  - autopilot --sync-roadmap-markers --dry-run excludes synced phases.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
for sub in ("scripts", "shared-utilities/scripts"):
    sys.path.insert(0, str(PLUGIN_ROOT / sub))

import local_claim_ops  # noqa: E402

LOCAL_OPS = PLUGIN_ROOT / "scripts" / "local_claim_ops.py"
AUTOPILOT = PLUGIN_ROOT / "scripts" / "autopilot.py"


SAMPLE_ROADMAP = """\
# Roadmap

## Priority: now

### 0.1a Identity — OIDC + JWT + dev mode **[Implemented — 2026-04-24]**

- **Definition of done**:
  - [x] OIDC login succeeds end-to-end

### 0.1b Organisations & environments **[Implemented — 2026-04-25]**

- **Definition of done**:
  - [x] Org create works

### 0.1c Service-to-service auth

- **Definition of done**:
  - [ ] mTLS works
"""


def _git_init(repo: Path) -> None:
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test User"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "commit.gpgsign", "false"], check=True)


class _SyncTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp(prefix="sync-test-"))
        self.repo = self.tmpdir / "repo"
        (self.repo / "docs").mkdir(parents=True)
        (self.repo / ".claude").mkdir()
        (self.repo / "docs" / "roadmap.md").write_text(SAMPLE_ROADMAP)
        _git_init(self.repo)
        # initial commit so HEAD exists for _git_commit's rev-parse
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-q", "-m", "init"], check=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _run_sync(self) -> dict:
        out = subprocess.run(
            [sys.executable, str(LOCAL_OPS), "sync-from-roadmap",
             "--repo", str(self.repo)],
            capture_output=True, text=True, check=True,
        )
        return json.loads(out.stdout)

    def _claims(self) -> dict:
        f = self.repo / ".claude" / "roadmap-claims.json"
        if not f.exists():
            return {}
        return json.loads(f.read_text())


class MarkerParserTests(unittest.TestCase):
    def test_extracts_id_and_date(self) -> None:
        markers = local_claim_ops._parse_implemented_markers(SAMPLE_ROADMAP)
        ids = {pid for pid, _ in markers}
        dates = {date for _, date in markers}
        self.assertEqual(ids, {"0.1a", "0.1b"})
        self.assertEqual(dates, {"2026-04-24", "2026-04-25"})

    def test_skips_headings_without_markers(self) -> None:
        markers = local_claim_ops._parse_implemented_markers(SAMPLE_ROADMAP)
        self.assertNotIn("0.1c", {pid for pid, _ in markers})

    def test_supports_hyphen_minus_dash(self) -> None:
        text = "### 1.1a Foo **[Implemented - 2026-01-01]**"
        markers = local_claim_ops._parse_implemented_markers(text)
        self.assertEqual(markers, [("1.1a", "2026-01-01")])


class SyncBehaviourTests(_SyncTestBase):
    def test_sync_promotes_markers_to_completed(self) -> None:
        result = self._run_sync()
        self.assertTrue(result["ok"])
        self.assertEqual(set(result["synced"]), {"0.1a", "0.1b"})
        self.assertIsNotNone(result["commit"])

        claims = self._claims()
        self.assertEqual(claims["0.1a"]["status"], "completed")
        self.assertEqual(claims["0.1b"]["status"], "completed")
        self.assertEqual(claims["0.1a"]["session_id"], "roadmap-sync-2026-04-24")
        self.assertEqual(claims["0.1a"]["released_by"], "roadmap-sync")
        self.assertNotIn("0.1c", claims)  # no marker → no claim

    def test_sync_is_idempotent(self) -> None:
        first = self._run_sync()
        second = self._run_sync()
        self.assertEqual(set(first["synced"]), {"0.1a", "0.1b"})
        self.assertEqual(second["synced"], [])
        self.assertIsNone(second["commit"])
        self.assertEqual(set(second["already_completed"]), {"0.1a", "0.1b"})

    def test_sync_emits_one_commit_only(self) -> None:
        self._run_sync()
        log_count_first = subprocess.run(
            ["git", "-C", str(self.repo), "rev-list", "--count", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        self._run_sync()
        log_count_second = subprocess.run(
            ["git", "-C", str(self.repo), "rev-list", "--count", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        self.assertEqual(log_count_first, log_count_second)

    def test_sync_refuses_to_clobber_active_claim(self) -> None:
        # Pre-seed an active claim for 0.1a
        f = self.repo / ".claude" / "roadmap-claims.json"
        f.write_text(json.dumps({
            "0.1a": {
                "feature_id": "0.1a",
                "session_id": "live-session",
                "claimed_at": "2026-04-25T12:00:00+00:00",
                "status": "active",
                "ttl_hours": 24,
            }
        }))
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-q",
                        "-m", "seed active"], check=True)
        result = self._run_sync()
        self.assertIn("0.1a", result["skipped_active"])
        self.assertEqual(result["synced"], ["0.1b"])
        claims = self._claims()
        self.assertEqual(claims["0.1a"]["status"], "active")
        self.assertEqual(claims["0.1a"]["session_id"], "live-session")
        self.assertEqual(claims["0.1b"]["status"], "completed")

    def test_sync_with_no_markers_emits_no_commit(self) -> None:
        (self.repo / "docs" / "roadmap.md").write_text(
            "### 0.1a Something\n### 0.1b Another\n"
        )
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-q",
                        "-m", "no markers"], check=True)
        result = self._run_sync()
        self.assertEqual(result["synced"], [])
        self.assertIsNone(result["commit"])
        f = self.repo / ".claude" / "roadmap-claims.json"
        self.assertFalse(f.exists())


class AutopilotIntegrationTests(_SyncTestBase):
    def setUp(self) -> None:
        super().setUp()
        # autopilot reads .orchestrator/config.yaml; create one with parallel=2
        cfg_dir = self.repo / ".orchestrator"
        cfg_dir.mkdir()
        (cfg_dir / "config.yaml").write_text("MAX_PARALLEL_SESSIONS: 2\n")
        # autopilot also needs phased_roadmap_parser.py; it's part of the plugin,
        # so the sibling import works directly. No extra setup.

    def test_dry_run_with_sync_excludes_synced_phases(self) -> None:
        result = subprocess.run(
            [sys.executable, str(AUTOPILOT),
             "--repo-root", str(self.repo),
             "--sync-roadmap-markers", "--dry-run"],
            capture_output=True, text=True, check=True,
        )
        # Synced phases (0.1a, 0.1b) should not appear in candidates;
        # 0.1c (no marker) should be the candidate.
        self.assertIn("0.1c", result.stdout)
        self.assertNotIn("would dispatch: 0.1a", result.stdout)
        self.assertNotIn("would dispatch: 0.1b", result.stdout)

        # And the claims file now contains the synced entries.
        claims = self._claims()
        self.assertEqual(claims["0.1a"]["status"], "completed")
        self.assertEqual(claims["0.1b"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()

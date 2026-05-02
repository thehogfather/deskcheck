"""Unit tests for the unified flat-dict claims schema in roadmap_ops.py.

Regression guards for the bug where roadmap_ops.py wrote
{"version":1,"claims":[...]} while autopilot.py and local_claim_ops.py
read a flat dict keyed by feature_id, making documented claim ops
invisible to autopilot.

Run from plugin root with: python3 -m unittest discover tests -v
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Path setup mirrors conftest.py for unittest mode.
PLUGIN_ROOT = Path(__file__).resolve().parent.parent
for sub in ("shared-utilities/scripts", "scripts"):
    sys.path.insert(0, str(PLUGIN_ROOT / sub))

import roadmap_ops  # noqa: E402


def _write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))


class _ClaimsTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp(prefix="roadmap-ops-test-"))
        self.claims_file = self.tmpdir / ".claude" / "roadmap-claims.json"
        self.roadmap_md = self.tmpdir / "roadmap.md"
        self.roadmap_md.write_text(
            "## Priority: now\n\n### 25 Sample feature\n\n- [ ] Task one\n"
        )
        os.environ["ROADMAP_OPS_QUIET_MIGRATION"] = "1"

    def tearDown(self) -> None:
        os.environ.pop("ROADMAP_OPS_QUIET_MIGRATION", None)
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class LoadClaimsTests(_ClaimsTestBase):
    def test_legacy_versioned_returns_flat_dict(self) -> None:
        legacy = {
            "version": 1,
            "claims": [{
                "feature_id": "feature-25",
                "feature_title": "Sample",
                "claimed_by": "sess-1",
                "claimed_at": "2026-04-20T00:00:00+00:00",
                "status": "completed",
            }],
        }
        _write(self.claims_file, legacy)
        result = roadmap_ops._load_claims_dict(str(self.claims_file))
        self.assertEqual(set(result.keys()), {"feature-25"})
        self.assertEqual(result["feature-25"]["session_id"], "sess-1")
        self.assertEqual(result["feature-25"]["claimed_by"], "sess-1")

    def test_flat_dict_passthrough(self) -> None:
        flat = {
            "0.1a": {
                "session_id": "orch-1",
                "claimed_at": "2026-04-25T06:00:00+00:00",
                "status": "completed",
                "ttl_hours": 24,
            }
        }
        _write(self.claims_file, flat)
        result = roadmap_ops._load_claims_dict(str(self.claims_file))
        self.assertIn("0.1a", result)

    def test_missing_file_returns_empty(self) -> None:
        self.assertEqual(roadmap_ops._load_claims_dict(str(self.claims_file)), {})

    def test_corrupt_file_raises(self) -> None:
        self.claims_file.parent.mkdir(parents=True)
        self.claims_file.write_text("not json {{{")
        with self.assertRaises(json.JSONDecodeError):
            roadmap_ops._load_claims_dict(str(self.claims_file))

    def test_unknown_shape_raises(self) -> None:
        _write(self.claims_file, ["not", "a", "dict"])
        with self.assertRaises(ValueError):
            roadmap_ops._load_claims_dict(str(self.claims_file))


class ClaimFeatureTests(_ClaimsTestBase):
    def test_phased_id_writes_flat_dict_with_raw_key(self) -> None:
        res = roadmap_ops.claim_feature(
            str(self.roadmap_md), "0.1a", "sess-A",
            claims_file=str(self.claims_file),
        )
        self.assertTrue(res["success"])
        on_disk = json.loads(self.claims_file.read_text())
        self.assertIn("0.1a", on_disk)
        self.assertNotIn("claims", on_disk)
        self.assertEqual(on_disk["0.1a"]["session_id"], "sess-A")
        self.assertEqual(on_disk["0.1a"]["status"], "active")

    def test_bare_integer_id_gets_feature_prefix(self) -> None:
        res = roadmap_ops.claim_feature(
            str(self.roadmap_md), "25", "sess-A",
            claims_file=str(self.claims_file),
        )
        self.assertTrue(res["success"])
        on_disk = json.loads(self.claims_file.read_text())
        self.assertIn("feature-25", on_disk)
        self.assertNotIn("25", on_disk)

    def test_phased_id_keeps_raw_form(self) -> None:
        res = roadmap_ops.claim_feature(
            str(self.roadmap_md), "1.2c", "sess-B",
            claims_file=str(self.claims_file),
        )
        self.assertTrue(res["success"])
        on_disk = json.loads(self.claims_file.read_text())
        self.assertIn("1.2c", on_disk)

    def test_legacy_to_flat_migration_on_first_write(self) -> None:
        legacy = {
            "version": 1,
            "claims": [{
                "feature_id": "feature-25",
                "claimed_by": "sess-old",
                "claimed_at": "2026-04-20T00:00:00+00:00",
                "status": "completed",
            }],
        }
        _write(self.claims_file, legacy)
        res = roadmap_ops.claim_feature(
            str(self.roadmap_md), "0.1b", "sess-new",
            claims_file=str(self.claims_file),
        )
        self.assertTrue(res["success"])
        on_disk = json.loads(self.claims_file.read_text())
        self.assertNotIn("claims", on_disk)
        self.assertNotIn("version", on_disk)
        self.assertIn("feature-25", on_disk)
        self.assertEqual(on_disk["feature-25"]["status"], "completed")
        self.assertIn("0.1b", on_disk)

    def test_already_claimed_returns_conflict(self) -> None:
        roadmap_ops.claim_feature(
            str(self.roadmap_md), "0.1a", "sess-A",
            claims_file=str(self.claims_file),
        )
        res = roadmap_ops.claim_feature(
            str(self.roadmap_md), "0.1a", "sess-B",
            claims_file=str(self.claims_file),
        )
        self.assertFalse(res["success"])
        self.assertEqual(res["error"], "already_claimed")
        self.assertEqual(res["claimed_by"], "sess-A")


class ReleaseClaimTests(_ClaimsTestBase):
    def test_release_marks_completed_and_records_releaser(self) -> None:
        roadmap_ops.claim_feature(
            str(self.roadmap_md), "0.1a", "sess-X",
            claims_file=str(self.claims_file),
        )
        res = roadmap_ops.release_claim(
            "0.1a", "sess-X",
            claims_file=str(self.claims_file), status="completed",
        )
        self.assertTrue(res["success"])
        on_disk = json.loads(self.claims_file.read_text())
        self.assertEqual(on_disk["0.1a"]["status"], "completed")
        self.assertEqual(on_disk["0.1a"]["released_by"], "sess-X")
        self.assertIn("released_at", on_disk["0.1a"])

    def test_release_accepts_legacy_claimed_by_owner(self) -> None:
        legacy = {
            "version": 1,
            "claims": [{
                "feature_id": "0.1a",
                "claimed_by": "sess-old",
                "claimed_at": "2026-04-20T00:00:00+00:00",
                "status": "active",
            }],
        }
        _write(self.claims_file, legacy)
        res = roadmap_ops.release_claim(
            "0.1a", "sess-old",
            claims_file=str(self.claims_file), status="completed",
        )
        self.assertTrue(res["success"])
        on_disk = json.loads(self.claims_file.read_text())
        self.assertEqual(on_disk["0.1a"]["status"], "completed")


class ListClaimsTests(_ClaimsTestBase):
    def test_list_after_legacy_migration(self) -> None:
        legacy = {
            "version": 1,
            "claims": [{
                "feature_id": "feature-25",
                "claimed_by": "sess-old",
                "claimed_at": "2026-04-20T00:00:00+00:00",
                "status": "active",
            }],
        }
        _write(self.claims_file, legacy)
        listed = roadmap_ops.list_claims(
            claims_file=str(self.claims_file), status_filter="active",
        )
        self.assertTrue(any(c["feature_id"] == "feature-25" for c in listed))


class CrossToolVisibilityTests(unittest.TestCase):
    """End-to-end regression: a claim made via roadmap_ops must be readable by
    local_claim_ops.py — exactly the bug the user hit."""

    def setUp(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp(prefix="roadmap-ops-cross-"))
        repo = self.tmpdir / "repo"
        (repo / ".claude").mkdir(parents=True)
        (repo / ".git").mkdir()
        (repo / "docs").mkdir()
        (repo / "docs" / "roadmap.md").write_text(
            "## Priority: now\n\n### 25 Sample feature\n\n- [ ] Task one\n"
        )
        # local_claim_ops.list reads the claims file but does not require git
        # to be initialised because it has its own .git/.../lock path; .git/
        # being a directory is enough to satisfy the lock parent.
        self.repo = repo

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_claim_from_roadmap_ops_visible_via_local_claim_ops_list(self) -> None:
        claims_file = self.repo / ".claude" / "roadmap-claims.json"
        roadmap_ops.claim_feature(
            str(self.repo / "docs" / "roadmap.md"), "0.1a", "sess-cross",
            claims_file=str(claims_file),
        )
        local_ops = PLUGIN_ROOT / "scripts" / "local_claim_ops.py"
        out = subprocess.run(
            [sys.executable, str(local_ops), "list", "--repo", str(self.repo)],
            capture_output=True, text=True, check=True,
        )
        listed = json.loads(out.stdout)
        ids = {c["feature_id"] for c in listed}
        self.assertIn("0.1a", ids, f"local_claim_ops.list returned: {listed}")


if __name__ == "__main__":
    unittest.main()

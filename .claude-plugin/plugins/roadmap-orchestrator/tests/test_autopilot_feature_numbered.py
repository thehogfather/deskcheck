"""Regression coverage for autopilot's feature-numbered roadmap support.

The original autopilot was hard-wired to fabrick-style phased headings
(`### 0.4 Title`, claim ids = bare numbers). Feature-numbered roadmaps
(`### 1. Title`, claim ids = `feature-N`) lived alongside `roadmap_ops.py`
support but couldn't be dispatched. These tests pin the new helpers so the
two conventions can coexist.

Run from plugin root with: python3 -m unittest discover tests -v
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from autopilot import (  # noqa: E402
    PHASE_HEADING_RE,
    _all_phase_ids,
    _dep_satisfied,
    _roadmap_dod_complete,
    _roadmap_prose_deps,
)


FEATURE_ROADMAP = dedent(
    """\
    # Roadmap

    ## Priority: Now

    ### 1. Already done
    - **Definition of done**:
      - [x] One
      - [x] Two

    ### 2. Half done
    - **Dependencies**: Feature #1 (something)
    - **Definition of done**:
      - [x] One
      - [ ] Two

    ### 3. Not started
    - **Dependencies**: None — independent
    - **Definition of done**:
      - [ ] One

    ## Priority: Next

    ### 4. Backlog
    - **Definition of done**:
      - [ ] x
    """
)

FABRICK_ROADMAP = dedent(
    """\
    # Roadmap

    ## Priority: Now — Phase 0

    ### 0.4 Run lifecycle
    - Definition of done:
      - [ ] foo

    ### 0.5a Sub-phase
    - Definition of done:
      - [ ] bar

    ### 10. ~~Killed~~ — superseded
    - Definition of done:
      - [ ] never
    """
)


class HeadingRegexTests(unittest.TestCase):
    def test_matches_period_after_number(self):
        self.assertEqual(
            [m.group(1) for m in PHASE_HEADING_RE.finditer("### 1. Title\n")],
            ["1"],
        )

    def test_matches_phased_no_period(self):
        self.assertEqual(
            [m.group(1) for m in PHASE_HEADING_RE.finditer("### 0.4 Title\n")],
            ["0.4"],
        )

    def test_matches_alpha_suffix(self):
        self.assertEqual(
            [m.group(1) for m in PHASE_HEADING_RE.finditer("### 0.5a Sub\n")],
            ["0.5a"],
        )


class PhaseIdsTests(unittest.TestCase):
    def test_feature_prefix_is_applied(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            ids = _all_phase_ids(rp, feature_id_prefix="feature-")
            self.assertEqual(
                [pid for pid, _ in ids],
                ["feature-1", "feature-2", "feature-3", "feature-4"],
            )

    def test_priority_section_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            ids = _all_phase_ids(
                rp,
                feature_id_prefix="feature-",
                priority_sections=["Priority: Now"],
            )
            self.assertEqual(
                [pid for pid, _ in ids],
                ["feature-1", "feature-2", "feature-3"],
            )

    def test_strikethrough_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FABRICK_ROADMAP)
            ids = [pid for pid, _ in _all_phase_ids(rp)]
            self.assertIn("0.4", ids)
            self.assertIn("0.5a", ids)
            self.assertNotIn("10", ids)

    def test_default_no_prefix_preserves_phased_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FABRICK_ROADMAP)
            ids = [pid for pid, _ in _all_phase_ids(rp)]
            self.assertEqual(ids, ["0.4", "0.5a"])


class DodCompletionTests(unittest.TestCase):
    def test_all_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            self.assertTrue(_roadmap_dod_complete(rp, "1"))

    def test_partial_not_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            self.assertFalse(_roadmap_dod_complete(rp, "2"))

    def test_no_checkboxes_not_complete(self):
        # A section without any DoD checkboxes shouldn't claim completion —
        # we want explicit evidence, not absence.
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text("## Priority: Now\n\n### 9. Empty\n- prose only\n")
            self.assertFalse(_roadmap_dod_complete(rp, "9"))


class ProseDepsTests(unittest.TestCase):
    def test_extracts_feature_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            self.assertEqual(
                _roadmap_prose_deps(rp, "2", "feature-"), ["feature-1"]
            )

    def test_none_yields_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            self.assertEqual(
                _roadmap_prose_deps(rp, "3", "feature-"), []
            )

    def test_no_prefix_means_no_prose_deps(self):
        # Phased roadmaps go through the spec parser; we don't want to
        # accidentally graft prose deps onto them.
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            self.assertEqual(_roadmap_prose_deps(rp, "2", ""), [])


class DepSatisfiedTests(unittest.TestCase):
    def test_completed_claim_satisfies(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            claims = {"feature-1": {"status": "completed"}}
            self.assertTrue(
                _dep_satisfied(claims, "feature-1", rp, "feature-")
            )

    def test_dod_complete_satisfies_without_claim(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            self.assertTrue(_dep_satisfied({}, "feature-1", rp, "feature-"))

    def test_unmet_dep(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp = Path(tmp) / "roadmap.md"
            rp.write_text(FEATURE_ROADMAP)
            self.assertFalse(_dep_satisfied({}, "feature-2", rp, "feature-"))


class WorktreeExistsTests(unittest.TestCase):
    def test_accepts_phase_id_directly(self):
        # The feature-numbered orchestrator builds .claude/worktrees/<phase_id>
        # without the redundant feature- prefix.
        from autopilot import _worktree_exists
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / ".claude" / "worktrees" / "feature-16").mkdir(parents=True)
            self.assertTrue(_worktree_exists(repo, "feature-16"))

    def test_accepts_legacy_feature_prefix(self):
        from autopilot import _worktree_exists
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / ".claude" / "worktrees" / "feature-0.4").mkdir(parents=True)
            self.assertTrue(_worktree_exists(repo, "0.4"))

    def test_returns_false_when_missing(self):
        from autopilot import _worktree_exists
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / ".claude" / "worktrees").mkdir(parents=True)
            self.assertFalse(_worktree_exists(repo, "feature-99"))


if __name__ == "__main__":
    unittest.main()

import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import { parseCommit, generateNotes, prependChangelogSection } from "../scripts/release-notes.mjs";

describe("parseCommit", () => {
  it("parses type, scope, and description", () => {
    expect(parseCommit("feat(feature-7): opt-in tab switching")).toEqual({
      type: "feat",
      scope: "feature-7",
      breaking: false,
      description: "opt-in tab switching",
    });
  });

  it("parses a scopeless commit", () => {
    expect(parseCommit("fix: harden tab switching")).toMatchObject({
      type: "fix",
      scope: null,
      description: "harden tab switching",
    });
  });

  it("flags breaking changes marked with !", () => {
    expect(parseCommit("feat(export)!: rename session.json fields")).toMatchObject({
      type: "feat",
      breaking: true,
    });
  });

  it("returns null for merge commits", () => {
    expect(parseCommit("Merge pull request #23 from thehogfather/feature/feature-7")).toBeNull();
  });

  it("classifies non-conventional subjects as other", () => {
    expect(parseCommit("Initial commit")).toMatchObject({
      type: "other",
      description: "Initial commit",
    });
  });
});

describe("generateNotes", () => {
  it("groups commits into sections in a fixed order", () => {
    const notes = generateNotes([
      "fix(feature-7): harden tab switching",
      "feat(feature-17): two-row toolbar",
      "perf: throttle scroll capture",
    ]);
    const featIdx = notes.indexOf("### Features");
    const fixIdx = notes.indexOf("### Fixes");
    const perfIdx = notes.indexOf("### Performance");
    expect(featIdx).toBeGreaterThanOrEqual(0);
    expect(fixIdx).toBeGreaterThan(featIdx);
    expect(perfIdx).toBeGreaterThan(fixIdx);
    expect(notes).toContain("- two-row toolbar");
  });

  it("excludes internal-only commit types and merges", () => {
    const notes = generateNotes([
      "chore(roadmap): clear stale ledger entries",
      "docs(feature-7): correct stale comments",
      "test(feature-17): flesh out e2e spec",
      "ci: bump actions versions",
      "refactor: extract helper",
      "Merge pull request #21 from x/y",
      "feat: the only visible change",
    ]);
    expect(notes).toContain("- the only visible change");
    expect(notes).not.toContain("ledger");
    expect(notes).not.toContain("stale comments");
    expect(notes).not.toContain("e2e spec");
    expect(notes).not.toContain("actions versions");
    expect(notes).not.toContain("extract helper");
    expect(notes).not.toContain("Merge");
  });

  it("puts breaking changes first, even for skipped types", () => {
    const notes = generateNotes([
      "feat: normal feature",
      "refactor!: drop legacy popup entrypoint",
    ]);
    expect(notes.indexOf("### Breaking Changes")).toBeLessThan(notes.indexOf("### Features"));
    expect(notes).toContain("- drop legacy popup entrypoint");
  });

  it("dedupes identical descriptions within a section", () => {
    const notes = generateNotes(["fix: flaky test setup", "fix: flaky test setup"]);
    expect(notes.match(/flaky test setup/g)).toHaveLength(1);
  });

  it("falls back to a stub when nothing is user-facing", () => {
    const notes = generateNotes(["chore: bump deps"]);
    expect(notes).toContain("_No user-facing changes._");
  });

  it("appends a compare link when repo and tags are known", () => {
    const notes = generateNotes(["feat: x"], {
      fromTag: "v0.2.0",
      toTag: "v0.3.0",
      repoUrl: "https://github.com/thehogfather/deskcheck",
    });
    expect(notes).toContain(
      "**Full changelog**: https://github.com/thehogfather/deskcheck/compare/v0.2.0...v0.3.0",
    );
  });

  it("links to commit history for a first release (no fromTag)", () => {
    const notes = generateNotes(["feat: x"], {
      fromTag: null,
      toTag: "v0.1.0",
      repoUrl: "https://github.com/thehogfather/deskcheck",
    });
    expect(notes).toContain("https://github.com/thehogfather/deskcheck/commits/v0.1.0");
  });
});

describe("prependChangelogSection", () => {
  const section = "## [0.6.0] - 2026-07-12\n\n### Features\n- x\n";

  it("inserts the new section before the first existing release", () => {
    const existing = "# Changelog\n\nIntro text.\n\n## [0.2.0] - 2026-04-06\n\n- old\n";
    const result = prependChangelogSection(existing, section);
    expect(result.indexOf("Intro text.")).toBeLessThan(result.indexOf("[0.6.0]"));
    expect(result.indexOf("[0.6.0]")).toBeLessThan(result.indexOf("[0.2.0]"));
  });

  it("appends to a changelog with no releases yet", () => {
    const result = prependChangelogSection("# Changelog\n", section);
    expect(result).toContain("# Changelog");
    expect(result).toContain("[0.6.0]");
  });
});

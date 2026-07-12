// Generates concise release notes from conventional commit subjects.
//
// Library: parseCommit() and generateNotes() are pure and unit-tested.
// CLI:
//   node scripts/release-notes.mjs notes <from-ref> <to-ref>
//     Print release-notes markdown for commits in from-ref..to-ref to stdout.
//     Pass "" as <from-ref> for a first release (all history up to to-ref).
//   node scripts/release-notes.mjs changelog <version>
//     Generate a section for commits since the last tag and prepend it
//     to CHANGELOG.md.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const COMMIT_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

// Conventional-commit types that matter to someone installing the artifact.
const SECTIONS = [
  { key: "breaking", title: "Breaking Changes" },
  { key: "feat", title: "Features" },
  { key: "fix", title: "Fixes" },
  { key: "perf", title: "Performance" },
  { key: "other", title: "Other" },
];

// Internal-only types: invisible in the shipped artifact, so excluded.
const SKIPPED_TYPES = new Set(["chore", "docs", "test", "style", "refactor", "build", "ci"]);

export function parseCommit(subject) {
  const s = subject.trim();
  if (s === "" || /^Merge /.test(s)) return null;
  const m = s.match(COMMIT_RE);
  if (!m) return { type: "other", scope: null, breaking: false, description: s };
  const [, type, scope, bang, description] = m;
  return { type, scope: scope || null, breaking: bang === "!", description };
}

export function generateNotes(subjects, { fromTag, toTag, repoUrl } = {}) {
  const buckets = new Map(SECTIONS.map((s) => [s.key, []]));
  const seen = new Set();

  for (const subject of subjects) {
    const c = parseCommit(subject);
    if (!c) continue;
    if (!c.breaking && SKIPPED_TYPES.has(c.type)) continue;
    const key = buckets.has(c.type) ? c.type : "other";
    const bucket = c.breaking ? "breaking" : key;
    const dedupeKey = `${bucket}:${c.description}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    buckets.get(bucket).push(c.description);
  }

  const parts = [];
  for (const { key, title } of SECTIONS) {
    const items = buckets.get(key);
    if (items.length === 0) continue;
    parts.push(`### ${title}\n${items.map((d) => `- ${d}`).join("\n")}`);
  }
  if (parts.length === 0) parts.push("_No user-facing changes._");
  if (repoUrl && toTag) {
    const compare = fromTag
      ? `${repoUrl}/compare/${fromTag}...${toTag}`
      : `${repoUrl}/commits/${toTag}`;
    parts.push(`**Full changelog**: ${compare}`);
  }
  return parts.join("\n\n") + "\n";
}

export function prependChangelogSection(changelog, section) {
  const lines = changelog.split("\n");
  const firstRelease = lines.findIndex((l) => l.startsWith("## "));
  if (firstRelease === -1) return changelog.trimEnd() + "\n\n" + section;
  return [...lines.slice(0, firstRelease), section, ...lines.slice(firstRelease)].join("\n");
}

// ---------------------------------------------------------------- CLI

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function commitSubjects(from, to) {
  const range = from ? `${from}..${to}` : to;
  const out = git("log", "--no-merges", "--pretty=format:%s", range);
  return out === "" ? [] : out.split("\n");
}

function originUrl() {
  try {
    return git("remote", "get-url", "origin")
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "");
  } catch {
    return null;
  }
}

function lastTag() {
  try {
    return git("describe", "--tags", "--abbrev=0");
  } catch {
    return null;
  }
}

function main([mode, ...args]) {
  if (mode === "notes") {
    const [fromTag, toTag] = args;
    if (!toTag) throw new Error("usage: release-notes.mjs notes <from-ref> <to-ref>");
    const notes = generateNotes(commitSubjects(fromTag, toTag), {
      fromTag: fromTag || null,
      toTag,
      repoUrl: originUrl(),
    });
    process.stdout.write(notes);
  } else if (mode === "changelog") {
    const [version] = args;
    if (!version) throw new Error("usage: release-notes.mjs changelog <version>");
    const from = lastTag();
    const notes = generateNotes(commitSubjects(from, "HEAD"));
    const date = new Date().toISOString().slice(0, 10);
    const section = `## [${version}] - ${date}\n\n${notes}`;
    const existing = existsSync("CHANGELOG.md")
      ? readFileSync("CHANGELOG.md", "utf8")
      : "# Changelog\n";
    writeFileSync("CHANGELOG.md", prependChangelogSection(existing, section));
    console.log(`CHANGELOG.md: added section for ${version} (${from || "start"}..HEAD)`);
  } else {
    throw new Error("usage: release-notes.mjs <notes|changelog> ...");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

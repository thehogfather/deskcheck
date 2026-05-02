---
name: roadmap-alignment
description: |
  Integration with product-roadmap-refiner skill for persona alignment and duplication checking. Use before finalizing implementation to ensure alignment with product strategy.
---

# Roadmap Alignment Skill

## Overview

Before marking a task complete, verify alignment with:
- **Product roadmap** - Avoid duplication, ensure coordination
- **Personas** - Verify the task serves defined user personas
- **Existing work** - Check for clashes with in-progress features

## When to Use

Check roadmap alignment:
- Before evidence approval checkpoint
- When implementing features from roadmap
- When user request might duplicate existing plans

## Finding the Roadmap

Common locations:
```bash
# Check for roadmap files
find . -name "*roadmap*.md" -o -name "*ROADMAP*.md" | head -5

# Common paths
./ROADMAP.md
./docs/ROADMAP.md
./docs/roadmap.md
./.github/ROADMAP.md
```

## Duplication Check

### Process

1. Extract key entities from current task
2. Search roadmap for similar items
3. Assess similarity level
4. Recommend action

### Similarity Assessment

```markdown
## Duplication Check

**Current Task**: [Description]

### Keywords Extracted
- [Keyword 1]
- [Keyword 2]
- [Keyword 3]

### Roadmap Items Searched
| Item | Priority | Status | Similarity |
|------|----------|--------|------------|
| [Existing item 1] | Now | In Progress | High |
| [Existing item 2] | Next | Planned | Medium |
| [Existing item 3] | Later | Planned | Low |

### Analysis

**High Similarity Found**: [Item]
- Current task: [What we're doing]
- Existing item: [What's already planned]
- Overlap: [Specific overlap]

### Recommendation
- [ ] **No duplicates** - Proceed
- [ ] **Duplicate found** - Merge with [Item] or defer
- [ ] **Related item** - Coordinate with [Item] implementation
- [ ] **Superset** - Current task includes [Item], update roadmap
```

### Handling Duplicates

| Situation | Action |
|-----------|--------|
| Exact duplicate | Stop, use existing roadmap item |
| Subset of existing | Proceed, note dependency |
| Superset of existing | Proceed, mark existing as included |
| Related but different | Proceed, note coordination needed |

## Persona Alignment

### Loading Personas

Personas are typically defined in:
- Roadmap file (under "Personas" section)
- Separate persona documents
- Product requirements docs

### Persona Structure

From the `product-roadmap-refiner` skill:

```markdown
### Persona: [Name]
- **Role**: [Who they are]
- **Primary Goal**: [What they want to achieve]
- **Pain Points**: [Current frustrations]
- **Success Metrics**: [How they measure success]
```

### Alignment Verification

```markdown
## Persona Alignment

**Task**: [Description]

### Target Persona(s)
| Persona | Goal Alignment | Impact |
|---------|----------------|--------|
| Parity Developer | Serves primary goal of migration verification | High |
| Comparison Researcher | Secondary benefit for competitive analysis | Medium |

### Alignment Analysis

**Primary Persona**: [Name]
- Their goal: [Goal from persona definition]
- How task serves goal: [Explanation]
- Success metric impact: [How this helps their metrics]

**Alignment Score**: Strong / Moderate / Weak / None

### Recommendation
- [x] Well-aligned with [Persona] - Proceed
- [ ] Partially aligned - Consider scope adjustment
- [ ] Misaligned - Consider parking or killing
- [ ] New persona needed - Document new user type
```

### Using product-roadmap-refiner

Invoke the skill to validate alignment:

```markdown
Use the product-roadmap-refiner skill to:
1. Load existing personas from the roadmap
2. Validate this task against persona goals
3. Check for prioritization conflicts
4. Recommend alignment adjustments
```

## Clash Detection

### Types of Clashes

1. **File Conflicts** - Two features modifying same files
2. **Dependency Conflicts** - Feature A needs B, but B isn't done
3. **Architectural Conflicts** - Incompatible design decisions
4. **Resource Conflicts** - Same component, different directions

### Clash Detection Process

```markdown
## Clash Detection

### Upcoming Roadmap Items (Priority: Now/Next)
| Item | Status | Files Affected | Dependencies |
|------|--------|----------------|--------------|
| [Item 1] | In Progress | src/auth/* | None |
| [Item 2] | Planned | src/api/* | Item 1 |

### Current Task Analysis
- Files to modify: [List]
- Dependencies: [List]
- Architectural decisions: [List]

### Potential Clashes Identified
| Clash Type | With Item | Conflict | Resolution |
|------------|-----------|----------|------------|
| File | [Item 1] | Both modify src/auth/login.ts | Coordinate changes |
| Dependency | [Item 2] | We need API changes from Item 2 | Wait or implement ourselves |
| Architecture | [Item 3] | Different auth approaches | Align on approach first |

### Recommendations
1. [Specific recommendation for each clash]
2. [Coordination steps needed]
3. [Sequencing adjustments]
```

### Resolution Strategies

| Clash Type | Strategy |
|------------|----------|
| File conflict | Coordinate timing, merge carefully |
| Dependency | Wait, implement dependency, or stub |
| Architecture | Escalate to design discussion |
| Resource | Prioritize, sequence, or parallelize |

## Integration with Orchestrator

### When to Run

```
Implementation Complete
        ↓
   Run Tests ✓
        ↓
Roadmap Alignment Check  ← This skill
        ↓
Collect Evidence
        ↓
Evidence Checkpoint
```

### Alignment Report

Include in evidence for checkpoint:

```markdown
## Roadmap Alignment Report

### Duplication Check
- Status: **No duplicates found**
- Related items: [List if any]

### Persona Alignment
- Primary persona: [Name]
- Alignment score: **Strong**
- Impact: [Description]

### Clash Detection
- Active clashes: **None**
- Coordination needed: [List if any]

### Recommendation
**Proceed with evidence approval** - Task is well-aligned with product strategy.
```

## Updating the Roadmap

After task completion, update roadmap:

### If Task Was a Roadmap Item

```markdown
Before:
- [ ] Task description

After:
- [x] Task description ✓ Completed [date]
```

### If Task Is Related to Roadmap Items

Add note to related items:
```markdown
### Related Completions
- [Task description] completed [date] - [how it relates]
```

### If Task Creates New Capability

Consider adding to roadmap:
```markdown
## Recently Completed
- [Task] - Enables [future work]
```

## Best Practices

1. **Check early** - Identify clashes before deep implementation
2. **Document relationships** - Future developers need context
3. **Update roadmap** - Keep it current as work completes
4. **Escalate conflicts** - Don't resolve architectural clashes silently
5. **Consider personas** - Every feature should serve someone

---
name: frontend-detection
description: |
  Detect when tasks require frontend work and coordinate with frontend-design and webapp-testing skills. Use during planning and validation to ensure proper UI handling.
---

# Frontend Detection Skill

## Overview

This skill:
1. **Detects** when a task involves frontend/UI work
2. **Coordinates** with `frontend-design` skill for implementation
3. **Collects UI evidence** via Playwright for validation

## Detection Signals

### File Pattern Detection

Check if task involves files matching:

```
# React/Vue/Svelte components
*.tsx, *.jsx, *.vue, *.svelte

# Component directories
**/components/**
**/pages/**
**/views/**
**/layouts/**

# Styling
*.css, *.scss, *.less, *.sass
*.styled.ts, *.styled.js
**/styles/**

# Frontend config
tailwind.config.*, postcss.config.*
vite.config.*, webpack.config.*
```

### Keyword Detection

Check task description for:

```regex
(UI|UX|component|button|form|modal|dialog|page|layout|style|CSS|frontend|user interface|design|responsive|mobile|tablet|desktop|animation|transition|theme|dark mode|light mode|accessibility|a11y)
```

### Task Type Detection

```regex
(add|create|build|implement|design|style).*(button|form|component|page|dashboard|widget|modal|dialog|navigation|menu|header|footer|sidebar|card|table|list|input|dropdown)
```

## Detection Result

```markdown
## Frontend Detection Result

**Task**: [Description]

### Detection Signals
| Signal Type | Found | Details |
|-------------|-------|---------|
| File patterns | Yes/No | [Files matching] |
| Keywords | Yes/No | [Keywords found] |
| Task type | Yes/No | [Pattern matched] |

### Verdict: FRONTEND_WORK_DETECTED / NO_FRONTEND_WORK

### If Frontend Detected
- **Component type**: [New component / Modify existing / Styling only]
- **Frameworks detected**: [React, Vue, Tailwind, etc.]
- **Scope**: [Single component / Page / System-wide]
```

## Integration Protocol

### When Frontend Work Is Detected

1. **Invoke frontend-design skill** for implementation:

```markdown
Use the frontend-design skill to:
- Design [component/page] with high aesthetic quality
- Follow existing design patterns in [src/components/]
- Use [Tailwind/styled-components/CSS modules] per project conventions
- Ensure responsive design (mobile-first)
- Meet accessibility standards (WCAG 2.1 AA)
```

2. **Plan evidence collection**:

Add to Definition of Done:
- [ ] Desktop screenshot captured
- [ ] Mobile screenshot captured
- [ ] Interaction video recorded (if interactive)
- [ ] Accessibility audit passed

### Evidence Collection via Playwright

#### Setup

```python
from playwright.sync_api import sync_playwright
from pathlib import Path

EVIDENCE_DIR = Path(".orchestrator/evidence/screenshots")
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
```

#### Responsive Screenshots

```python
def capture_responsive_screenshots(url: str, name: str):
    """Capture screenshots at multiple viewport sizes."""

    VIEWPORTS = [
        {"name": "mobile", "width": 375, "height": 667},
        {"name": "tablet", "width": 768, "height": 1024},
        {"name": "desktop", "width": 1440, "height": 900},
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        for vp in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": vp["width"], "height": vp["height"]}
            )
            page = context.new_page()
            page.goto(url)
            page.wait_for_load_state("networkidle")

            page.screenshot(
                path=EVIDENCE_DIR / f"{name}-{vp['name']}.png",
                full_page=True
            )
            context.close()

        browser.close()
```

#### Before/After Comparison

```python
def capture_before_after(url: str, change_description: str):
    """Capture state before and after a change."""

    # Before - capture current state
    capture_responsive_screenshots(url, "before")

    # [Implementation happens here]

    # After - capture new state
    capture_responsive_screenshots(url, "after")
```

#### Interaction Recording

```python
def record_interaction(url: str, actions: list, name: str):
    """Record a video of user interactions."""

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            record_video_dir=str(EVIDENCE_DIR),
            record_video_size={"width": 1280, "height": 720}
        )
        page = context.new_page()
        page.goto(url)
        page.wait_for_load_state("networkidle")

        # Execute actions
        for action in actions:
            if action["type"] == "click":
                page.click(action["selector"])
            elif action["type"] == "fill":
                page.fill(action["selector"], action["value"])
            elif action["type"] == "wait":
                page.wait_for_timeout(action["ms"])

        # Save video
        context.close()
        browser.close()

# Example usage
record_interaction(
    url="http://localhost:3000/login",
    actions=[
        {"type": "fill", "selector": "input[name='email']", "value": "test@example.com"},
        {"type": "fill", "selector": "input[name='password']", "value": "password123"},
        {"type": "click", "selector": "button[type='submit']"},
        {"type": "wait", "ms": 2000},
    ],
    name="login-flow"
)
```

#### Accessibility Audit

```python
def run_accessibility_audit(url: str):
    """Run axe accessibility audit."""

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(url)
        page.wait_for_load_state("networkidle")

        # Inject axe-core
        page.add_script_tag(url="https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.2/axe.min.js")

        # Run audit
        results = page.evaluate("() => axe.run()")

        # Save results
        with open(EVIDENCE_DIR / "accessibility-audit.json", "w") as f:
            json.dump(results, f, indent=2)

        # Summary
        violations = results.get("violations", [])
        print(f"Accessibility violations: {len(violations)}")
        for v in violations:
            print(f"  - {v['id']}: {v['description']} ({len(v['nodes'])} instances)")

        browser.close()
        return violations
```

## Using webapp-testing Skill

The `document-skills:webapp-testing` skill provides additional capabilities:

```markdown
Use the webapp-testing skill to:
1. Verify the new [component] renders correctly
2. Test interaction flow: [describe flow]
3. Capture screenshots at: [breakpoints]
4. Check for console errors
5. Verify network requests succeed
```

## Evidence Checklist

### For New Components
- [ ] Component renders without errors
- [ ] Desktop screenshot (1440px)
- [ ] Mobile screenshot (375px)
- [ ] Tablet screenshot (768px)
- [ ] No console errors
- [ ] Accessibility audit passes

### For Modifications
- [ ] Before screenshot
- [ ] After screenshot
- [ ] Existing functionality still works
- [ ] New functionality demonstrated
- [ ] No regression in other views

### For Interactive Features
- [ ] Interaction video recorded
- [ ] Happy path demonstrated
- [ ] Error states shown
- [ ] Loading states shown
- [ ] Edge cases handled

## Evidence Directory Structure

```
.orchestrator/evidence/
├── screenshots/
│   ├── before-desktop.png
│   ├── before-mobile.png
│   ├── after-desktop.png
│   ├── after-mobile.png
│   ├── component-states.png      # Multiple states in one image
│   └── interaction-flow.mp4
├── test-results.md
├── accessibility-audit.json
└── validation.md
```

## Integration with Orchestrator

### During Planning

```python
# In planner agents
if detect_frontend_work(task):
    add_to_plan("Invoke frontend-design skill")
    add_to_dod("UI evidence collected")
    add_to_testing("Visual regression tests")
```

### During Implementation

```python
# Coordinate with frontend-design
invoke_skill("frontend-design", {
    "component": component_spec,
    "design_system": detect_design_system(),
    "accessibility_level": "WCAG 2.1 AA"
})
```

### During Validation

```python
# Collect evidence before checkpoint
capture_responsive_screenshots(app_url, "final")

if is_interactive:
    record_interaction(app_url, interaction_steps, "demo")

run_accessibility_audit(app_url)
```

## Best Practices

1. **Detect early** - Check at planning phase, not just validation
2. **Match existing patterns** - Use project's existing component library
3. **Mobile first** - Design for mobile, verify responsive
4. **Accessibility always** - Not optional for user-facing features
5. **Capture state variations** - Show loading, error, empty, and success states
6. **Keep evidence small** - Compress images, short videos

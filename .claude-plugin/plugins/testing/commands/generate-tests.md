---
description: Generate comprehensive tests for code in the current project
argument-hint: Optional file path or feature to test
---

# Test Generation

Generate comprehensive tests for code in this project.

## Target

$ARGUMENTS

If no target specified, ask the user what they'd like to test:
- Recent changes (unstaged git diff)
- A specific file or directory
- A specific feature or module
- Browser/E2E testing for a web frontend

## Process

### 1. Discover Testing Context

First, understand how this project handles testing:

1. Look for test configuration files:
   - `jest.config.*`, `vitest.config.*`, `pytest.ini`, `pyproject.toml [tool.pytest]`
   - `package.json` scripts containing "test"
   - `.mocharc.*`, `karma.conf.*`, etc.

2. Find existing tests to understand conventions:
   - Test file locations (`__tests__/`, `*.test.*`, `*.spec.*`, `test_*.py`)
   - Naming patterns
   - Mocking approaches
   - Setup/teardown patterns

3. If no testing infrastructure exists:
   - **Ask user**: "This project doesn't have testing set up. Would you like me to configure a testing framework?"
   - If yes, recommend based on tech stack (Vitest for Vite/React, Jest for Node, Pytest for Python)
   - Set up minimal configuration

### 2. Analyze Target Code

Launch a test-writer agent to:
- Analyze the target code deeply
- Identify all test scenarios
- Generate comprehensive tests

**Agent prompt template**:
```
Analyze and generate tests for: [target]

Context:
- Testing framework: [detected framework]
- Test location convention: [detected pattern]
- Existing test examples: [file references]

Generate tests covering:
1. Happy path scenarios
2. Edge cases and boundary conditions
3. Error handling paths
4. Any async behavior

Follow the project's existing test conventions exactly.
```

### 2b. Browser/E2E Testing (if applicable)

If the target involves a web frontend or the user requests E2E tests:

1. Check for `playwright-cli` availability:
   ```bash
   npx playwright-cli --version
   ```
   If not available, offer to install: `npm install -g @playwright/cli@latest && playwright-cli install-browser`

2. Launch the test-writer agent with browser testing context:
   ```
   Perform E2E testing for: [target]

   Use the Playwright CLI snapshot-act loop:
   - Open the app URL with playwright-cli -s=e2e open <url>
   - snapshot to see the page
   - Interact using refs from the snapshot
   - snapshot again to verify results
   - screenshot to capture evidence

   Test the key user workflows and report any issues found.
   ```

### 3. Review and Run

1. Review generated tests for completeness
2. Run the tests to verify they pass:
   - `npm test` / `npm run test`
   - `pytest`
   - Or whatever the project uses
3. If tests fail, analyze why:
   - Bug in implementation? Report it.
   - Bug in test? Fix the test.
   - Missing mock? Add it.

### 4. Summary

Present:
- Tests created (files and test counts)
- Coverage summary if available
- Any issues found during test writing
- E2E test results and screenshots (if browser testing was performed)
- Suggestions for additional testing

## Skip Conditions

If user explicitly says "no tests" or declines testing setup, acknowledge and exit gracefully.

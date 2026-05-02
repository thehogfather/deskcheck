#!/bin/bash
# setup-workspace.sh - Initialize .orchestrator/ structure for orchestration
#
# Usage:
#   ./setup-workspace.sh [project_path]
#
# If no project_path is provided, uses current directory.
# Typically run inside a worktree so each feature gets its own workspace.

set -e

PROJECT_PATH="${1:-.}"
WORKSPACE_DIR="$PROJECT_PATH/.orchestrator"

echo "Initializing orchestration workspace at $WORKSPACE_DIR..."

# Create directory structure
mkdir -p "$WORKSPACE_DIR/plans"
mkdir -p "$WORKSPACE_DIR/evidence/screenshots"

# Initialize orchestration.log (empty JSON lines file)
touch "$WORKSPACE_DIR/orchestration.log"

# Create .gitignore for workspace
cat > "$WORKSPACE_DIR/.gitignore" << 'EOF'
# Orchestration workspace - local only
evidence/screenshots/*
!evidence/screenshots/.gitkeep
orchestration.log
session-summary.md
current-task.md
EOF

# Create .gitkeep for screenshots folder
touch "$WORKSPACE_DIR/evidence/screenshots/.gitkeep"

echo "Workspace initialized successfully!"
echo ""
echo "Structure created:"
echo "  $WORKSPACE_DIR/"
echo "  ├── plans/               # Plan files from speed/quality/safety agents"
echo "  ├── evidence/"
echo "  │   └── screenshots/     # Playwright screenshots (gitignored)"
echo "  ├── orchestration.log    # JSON events for OTEL fallback"
echo "  ├── current-task.md      # Current task metadata (gitignored)"
echo "  └── .gitignore           # Keeps local-only files out of git"
echo ""
echo "Run '/roadmap work' to begin orchestration."

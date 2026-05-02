---
name: observability
description: |
  OTEL event patterns and observability utilities for orchestration workflows. Pushes events directly to your local OTEL collector alongside Claude Code's native telemetry.
---

# Observability Skill

## Overview

This skill provides patterns for observability in orchestrated workflows. It combines:
- **Claude Code's native OTEL** (automatic metrics and events)
- **Custom orchestration events** (pushed directly to OTEL collector)

## Prerequisites

Install the OpenTelemetry Python SDK:
```bash
pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-grpc
```

Or with uv:
```bash
uv pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-grpc
```

## Two-Layer Observability

### Layer 1: Claude Code Native OTEL (Automatic)

Already configured in your settings:
```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4317"
  }
}
```

**Automatic Metrics:**
| Metric | Description |
|--------|-------------|
| `claude_code.session.count` | Session count |
| `claude_code.token.usage` | Token consumption by type |
| `claude_code.cost.usage` | USD cost by model |
| `claude_code.active_time.total` | Active coding time |
| `claude_code.lines_of_code.count` | Lines added/removed |
| `claude_code.code_edit_tool.decision` | Tool accept/reject |

**Automatic Events:**
| Event | Description |
|-------|-------------|
| `claude_code.user_prompt` | When user submits prompt |
| `claude_code.tool_result` | Tool execution results |
| `claude_code.api_request` | API call details |
| `claude_code.api_error` | API errors |
| `claude_code.tool_decision` | Permission decisions |

### Layer 2: Orchestration Events (Direct to OTEL)

Pushed directly to your OTEL collector at `localhost:4317` as spans.

**Resource Attributes** (on every span):
```
service.name: roadmap-orchestrator
service.version: 3.3.0
project.name: equivalence
project.path: /Users/patrick/Documents/workspace/equivalence
git.branch: main
git.commit: f0553a7
```

**Span Structure:**
```
Span: orchestration.task.start
├── Attributes:
│   ├── task_id: "xyz789"
│   ├── title: "Add user authentication"
│   └── event.timestamp: "2024-01-15T10:30:00.000Z"
└── Events:
    └── orchestration.task.start (with same attributes)
```

**Fallback:** If OTEL SDK not installed, writes to `.orchestrator/orchestration.log`

## Phase Boundary Events (automatic)

Every phase transition emits two events automatically:
1. `phase.[name].start` with `--attr phase_number=[N]`
2. `phase.[name].end` with `--attr phase_number=[N] --attr result=[success|failed]`

Only add manual emit calls for mid-phase events (plan.verified, plan.retry, etc.).

## Event Types

### Task Lifecycle

```bash
# Task Start
python3 emit_otel.py task.start \
  --attr task_id=abc123 \
  --attr title="Add login feature" \
  --attr source_prompt="implement user login"

# Task End
python3 emit_otel.py task.end \
  --attr task_id=abc123 \
  --attr duration_ms=3600000 \
  --attr status=success \
  --attr plans_generated=3 \
  --attr checkpoints_passed=2
```

### Agent Lifecycle

```bash
# Agent Spawn
python3 emit_otel.py agent.spawn \
  --attr agent=speed-planner \
  --attr model=sonnet \
  --attr task_id=abc123

# Agent Complete
python3 emit_otel.py agent.complete \
  --attr agent=speed-planner \
  --attr duration_ms=75000 \
  --attr status=success \
  --attr plan_score=4.2
```

### Plan Selection

```bash
python3 emit_otel.py plan.selected \
  --attr selected_plan=quality \
  --attr speed_score=3.5 \
  --attr quality_score=4.8 \
  --attr safety_score=4.2 \
  --attr rationale="Best balance of quality and testing"
```

### Checkpoints

```bash
# Plan Approval
python3 emit_otel.py checkpoint \
  --attr type=plan_approval \
  --attr result=approved \
  --attr wait_time_ms=120000 \
  --attr user_comment="Looks good"

# Evidence Approval
python3 emit_otel.py checkpoint \
  --attr type=evidence_approval \
  --attr result=approved \
  --attr evidence_items=5 \
  --attr dod_items_verified=4
```

### Feature Claims

```bash
# Feature Claimed (after successful push to main)
python3 emit_otel.py feature.claimed \
  --attr feature_id=feature-25 \
  --attr session_id=session-abc123 \
  --attr retry_count=0

# Feature Claim Released (on completion or abort)
python3 emit_otel.py feature.claim_released \
  --attr feature_id=feature-25 \
  --attr session_id=session-abc123 \
  --attr status=completed
```

### Evidence Collection

```bash
python3 emit_otel.py evidence.collected \
  --attr type=screenshot \
  --attr path=".orchestrator/evidence/screenshots/final.png" \
  --attr size_bytes=245000

python3 emit_otel.py evidence.collected \
  --attr type=test_results \
  --attr path=".orchestrator/evidence/test-results.md" \
  --attr tests_passed=45 \
  --attr tests_failed=0
```

## Grafana Integration

### Tempo (Traces)

Orchestration events appear as spans in Tempo. Query by:
- Service: `roadmap-orchestrator`
- Operation: `orchestration.task.start`, `orchestration.agent.spawn`, etc.

**Example TraceQL query:**
```
{resource.service.name="roadmap-orchestrator" && name=~"orchestration.task.*"}
```

### Correlating with Claude Code

Both Claude Code's native events and orchestration events go to the same collector.
Correlate using:
- `project.name` attribute (from orchestration events)
- Time window (both emit during same session)

**Grafana correlation query:**
```
{resource.service.name=~"claude-code|roadmap-orchestrator"} | select(name, resource.project.name)
```

### Grafana Queries

**Task Duration by Type:**
```logql
{job="claude-orchestration"} |= "task.end" | json | duration_ms > 0
```

**Agent Performance:**
```logql
{job="claude-orchestration", event="orchestration.agent.complete"}
| json
| line_format "{{.agent}}: {{.duration_ms}}ms"
```

**Checkpoint Approvals:**
```logql
{job="claude-orchestration", event="orchestration.checkpoint"}
| json
| result="approved"
```

## Correlating with Native OTEL

Claude Code's native events include `session.id`. To correlate:

1. **Log session ID** in your task.start event
2. **Query Tempo** for traces with matching session.id
3. **Join in Grafana** using session.id as the correlation key

Example correlation query:
```sql
SELECT
  o.task_id,
  o.duration_ms as task_duration,
  t.cost_usd as total_cost,
  t.token_usage as tokens
FROM orchestration_events o
JOIN tempo_traces t ON o.session_id = t.session_id
WHERE o.name = 'orchestration.task.end'
```

## Dashboard Suggestions

### Orchestration Overview
- Tasks started/completed per day
- Average task duration
- Plan selection distribution (speed vs quality vs safety)
- Checkpoint approval rate

### Agent Performance
- Agent spawn count by type
- Average duration per agent type
- Success/failure rate

### Evidence & Quality
- Test pass rate over time
- Evidence items collected per task
- DoD verification success rate

## Best Practices

1. **Always emit task.start/end** - provides the outer span
2. **Include task_id** in all events for correlation
3. **Use TaskUpdate** to keep phase tasks in sync
4. **Log before and after** checkpoints to measure wait time
5. **Include quantitative metrics** (duration_ms, counts) for analysis

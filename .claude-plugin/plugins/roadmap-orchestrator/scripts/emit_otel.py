#!/usr/bin/env python3
"""
emit_otel.py - Emit orchestration events directly to OTEL collector.

Pushes spans and events to your local OTEL collector at localhost:4317,
which then routes to Tempo (traces) and Loki (logs) via your Grafana stack.

Usage:
    python3 emit_otel.py <event_type> [--attr key=value ...] [--project /path]

Event Types:
    task.start          - Orchestration task started
    task.end            - Orchestration task completed
    agent.spawn         - Sub-agent spawned
    agent.complete      - Sub-agent finished
    plan.selected       - Judge selected winning plan
    checkpoint          - User checkpoint (plan_approval, evidence_approval)
    evidence.collected  - Evidence artifact saved

Examples:
    python3 emit_otel.py task.start --attr task_id=abc123 --attr title="Add login"
    python3 emit_otel.py agent.spawn --attr agent=speed-planner --attr model=sonnet
    python3 emit_otel.py validation_gate.passed --attr feature_id=user-auth --attr retry_count=0
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Check for OpenTelemetry SDK
try:
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION
    from opentelemetry.trace import Status, StatusCode
    OTEL_AVAILABLE = True
except ImportError:
    OTEL_AVAILABLE = False
    print("Warning: OpenTelemetry SDK not installed. Install with:", file=sys.stderr)
    print("  pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-grpc", file=sys.stderr)


def get_project_context() -> dict:
    """Extract project context from current directory."""
    cwd = Path.cwd()

    # Try to find project root (look for common markers)
    project_root = cwd
    for marker in ['.git', 'pyproject.toml', 'package.json', '.claude']:
        for parent in [cwd] + list(cwd.parents):
            if (parent / marker).exists():
                project_root = parent
                break

    # Extract project name from directory
    project_name = project_root.name

    # Try to get git info
    git_branch = None
    git_commit = None
    try:
        import subprocess
        git_branch = subprocess.check_output(
            ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
            cwd=project_root, stderr=subprocess.DEVNULL
        ).decode().strip()
        git_commit = subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=project_root, stderr=subprocess.DEVNULL
        ).decode().strip()
    except:
        pass

    return {
        "project.name": project_name,
        "project.path": str(project_root),
        "git.branch": git_branch,
        "git.commit": git_commit,
    }


def setup_otel(project_context: dict) -> tuple:
    """Initialize OpenTelemetry with OTLP exporter."""

    # Build resource attributes
    resource_attrs = {
        SERVICE_NAME: "roadmap-orchestrator",
        SERVICE_VERSION: "2.0.0",
        "deployment.environment": "local",
    }

    # Add project context
    for key, value in project_context.items():
        if value is not None:
            resource_attrs[key] = value

    resource = Resource.create(resource_attrs)

    # Get endpoint from environment or default
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

    # Remove http:// prefix if present (grpc doesn't want it)
    if endpoint.startswith("http://"):
        endpoint = endpoint[7:]
    elif endpoint.startswith("https://"):
        endpoint = endpoint[8:]

    # Create exporter and provider
    exporter = OTLPSpanExporter(
        endpoint=endpoint,
        insecure=True  # Local collector, no TLS
    )

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    return trace.get_tracer("roadmap-orchestrator", "2.0.0"), provider


def emit_event_otel(tracer: trace.Tracer, event_type: str, attributes: dict) -> dict:
    """Emit an event as an OTEL span."""

    span_name = f"orchestration.{event_type}"

    # Determine span kind based on event type
    if event_type in ["task.start", "task.end"]:
        kind = trace.SpanKind.INTERNAL
    elif event_type in ["agent.spawn", "agent.complete"]:
        kind = trace.SpanKind.INTERNAL
    else:
        kind = trace.SpanKind.INTERNAL

    # Create span
    with tracer.start_as_current_span(span_name, kind=kind) as span:
        # Add all attributes
        for key, value in attributes.items():
            if value is not None:
                # Convert to OTEL-compatible types
                if isinstance(value, bool):
                    span.set_attribute(key, value)
                elif isinstance(value, (int, float)):
                    span.set_attribute(key, value)
                else:
                    span.set_attribute(key, str(value))

        # Add timestamp
        span.set_attribute("event.timestamp", datetime.utcnow().isoformat() + "Z")

        # Set status based on event type
        if event_type == "task.end":
            status = attributes.get("status", "success")
            if status == "success":
                span.set_status(Status(StatusCode.OK))
            elif status in ["failed", "error"]:
                span.set_status(Status(StatusCode.ERROR, attributes.get("error", "Task failed")))

        # Add event to span for log correlation
        span.add_event(span_name, attributes=attributes)

    return {
        "name": span_name,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "attributes": attributes
    }


def emit_event_fallback(event_type: str, attributes: dict, project_context: dict) -> dict:
    """Fallback: write to file when OTEL SDK not available."""

    # Find workspace
    cwd = Path.cwd()
    workspace = cwd / ".claude" / "workspace"

    if not workspace.exists():
        workspace.mkdir(parents=True, exist_ok=True)

    log_file = workspace / "orchestration.log"

    event = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "name": f"orchestration.{event_type}",
        "attributes": {**attributes, **project_context},
        "service": "roadmap-orchestrator",
        "version": "2.0.0"
    }

    with open(log_file, "a") as f:
        f.write(json.dumps(event) + "\n")

    return event


def main():
    parser = argparse.ArgumentParser(
        description="Emit orchestration events to OTEL collector",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        "event_type",
        help="Type of event to emit (e.g. task.start, agent.complete, plan.selected, evidence.collected, validation_gate.passed)"
    )
    parser.add_argument(
        "--attr", "-a",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Event attribute (can be repeated)"
    )
    parser.add_argument(
        "--project",
        help="Project path (default: current directory)"
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress output"
    )
    parser.add_argument(
        "--file-fallback",
        action="store_true",
        help="Force file-based logging instead of OTEL"
    )

    args = parser.parse_args()

    # Change to project directory if specified
    if args.project:
        os.chdir(args.project)

    # Parse attributes
    attributes = {}
    for attr in args.attr:
        if "=" in attr:
            key, value = attr.split("=", 1)
            # Try to parse as number/bool
            try:
                value = json.loads(value)
            except (json.JSONDecodeError, ValueError):
                pass
            attributes[key] = value

    # Get project context
    project_context = get_project_context()

    # Emit event
    if OTEL_AVAILABLE and not args.file_fallback:
        try:
            tracer, provider = setup_otel(project_context)
            event = emit_event_otel(tracer, args.event_type, attributes)
            provider.shutdown()
            method = "otel"
        except Exception as e:
            if not args.quiet:
                print(f"OTEL export failed ({e}), falling back to file", file=sys.stderr)
            event = emit_event_fallback(args.event_type, attributes, project_context)
            method = "file"
    else:
        event = emit_event_fallback(args.event_type, attributes, project_context)
        method = "file"

    # Output
    if not args.quiet:
        output = {
            "status": "emitted",
            "method": method,
            "endpoint": os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317") if method == "otel" else "file",
            "event": event
        }
        print(json.dumps(output, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())

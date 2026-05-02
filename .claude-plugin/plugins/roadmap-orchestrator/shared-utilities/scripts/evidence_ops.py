#!/usr/bin/env python3
"""
Standardized evidence collection operations for Claude Code workflows.

Usage:
    python3 evidence_ops.py init <feature-id> [--workspace=.orchestrator]
    python3 evidence_ops.py validate <feature-id> [--workspace=.orchestrator]
    python3 evidence_ops.py collect-tests <feature-id> [--test-command="npm run test:run"]
    python3 evidence_ops.py summary <feature-id> [--workspace=.orchestrator]
"""

import os
import sys
import json
import subprocess
import argparse
import re
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, asdict, field
from typing import Optional, List


@dataclass
class EvidenceItem:
    type: str
    path: str
    collected_at: str
    valid: bool
    size_bytes: int
    notes: Optional[str] = None


@dataclass
class EvidenceReport:
    feature_id: str
    collected_at: str
    items: List[EvidenceItem] = field(default_factory=list)
    validation_passed: bool = False
    missing_required: List[str] = field(default_factory=list)


REQUIRED_EVIDENCE = {
    'test-results.md': 'Test execution results',
    'validation.md': 'DoD verification matrix',
}

OPTIONAL_EVIDENCE = {
    'screenshots/': 'Playwright screenshots (for UI work)',
}


def get_workspace_path(workspace: str = '.orchestrator') -> Path:
    """Get the workspace path, resolving relative to cwd."""
    path = Path(workspace)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path


def init_evidence(feature_id: str, workspace: str = '.orchestrator') -> dict:
    """Initialize evidence directory structure for a feature."""
    base = get_workspace_path(workspace) / 'evidence' / feature_id
    screenshots = base / 'screenshots'

    # Create directories
    screenshots.mkdir(parents=True, exist_ok=True)

    # Create empty template files
    test_results = base / 'test-results.md'
    if not test_results.exists():
        test_results.write_text(f"""# Test Results - {feature_id}

**Date:** {datetime.now().strftime('%Y-%m-%d')}
**Status:** pending

## Test Execution

```
(test output will be captured here)
```

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | - |
| Passed | - |
| Failed | - |
| Duration | - |
""")

    validation = base / 'validation.md'
    if not validation.exists():
        validation.write_text(f"""# Validation Report - {feature_id}

**Date:** {datetime.now().strftime('%Y-%m-%d')}
**Selected Plan:** (to be filled)

## Definition of Done Verification

| Requirement | Status | Evidence |
|-------------|--------|----------|
| | | |

## Files Changed

| File | Changes |
|------|---------|
| | |

## Validation Checklist

- [ ] TypeScript compiles without errors
- [ ] All tests pass
- [ ] No regression in existing functionality
- [ ] Code follows project conventions
""")

    return {
        'success': True,
        'feature_id': feature_id,
        'evidence_path': str(base),
        'files_created': [str(test_results), str(validation)],
        'directories_created': [str(screenshots)]
    }


def validate_evidence(feature_id: str, workspace: str = '.orchestrator') -> dict:
    """Validate that required evidence exists and is non-empty."""
    base = get_workspace_path(workspace) / 'evidence' / feature_id

    if not base.exists():
        return {
            'feature_id': feature_id,
            'validation_passed': False,
            'error': f'Evidence directory does not exist: {base}',
            'hint': f'Run: python3 evidence_ops.py init {feature_id}'
        }

    items = []
    missing = []

    for filename, description in REQUIRED_EVIDENCE.items():
        filepath = base / filename
        if filepath.exists():
            stat = filepath.stat()
            content = filepath.read_text()

            # Check if file has meaningful content (more than just template)
            # Look for specific template markers, not arbitrary words
            template_markers = [
                '(to be filled)',
                '(test output will be captured here)',
                'status: pending',  # Template status marker
                '| pending |',      # Table cell with pending status
            ]
            has_template_marker = any(marker in content.lower() for marker in template_markers)
            has_content = len(content) > 300 and not has_template_marker

            items.append(asdict(EvidenceItem(
                type='required',
                path=str(filepath),
                collected_at=datetime.fromtimestamp(stat.st_mtime).isoformat(),
                valid=has_content,
                size_bytes=stat.st_size,
                notes=description if has_content else f'{description} - appears incomplete'
            )))

            if not has_content:
                missing.append(f'{filename} (incomplete)')
        else:
            missing.append(filename)

    # Check optional evidence
    for dirname, description in OPTIONAL_EVIDENCE.items():
        dirpath = base / dirname.rstrip('/')
        if dirpath.exists() and dirpath.is_dir():
            files = list(dirpath.glob('*'))
            if files:
                items.append(asdict(EvidenceItem(
                    type='optional',
                    path=str(dirpath),
                    collected_at=datetime.now().isoformat(),
                    valid=True,
                    size_bytes=sum(f.stat().st_size for f in files if f.is_file()),
                    notes=f'{description} - {len(files)} files'
                )))

    return {
        'feature_id': feature_id,
        'collected_at': datetime.now().isoformat(),
        'validation_passed': len(missing) == 0,
        'items': items,
        'missing_required': missing
    }


def collect_tests(
    feature_id: str,
    test_command: str = 'npm run test:run',
    workspace: str = '.orchestrator'
) -> dict:
    """Run tests and capture output to evidence."""
    base = get_workspace_path(workspace) / 'evidence' / feature_id
    base.mkdir(parents=True, exist_ok=True)

    test_results_path = base / 'test-results.md'

    # Run tests
    try:
        result = subprocess.run(
            test_command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout
        )
        output = result.stdout + result.stderr
        success = result.returncode == 0
        exit_code = result.returncode
    except subprocess.TimeoutExpired:
        output = 'Test execution timed out (5 minute limit)'
        success = False
        exit_code = -1
    except Exception as e:
        output = f'Test execution failed: {e}'
        success = False
        exit_code = -1

    # Parse basic metrics from output
    metrics = parse_test_metrics(output)

    # Write results
    status = 'PASSED' if success else 'FAILED'
    content = f"""# Test Results - {feature_id}

**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
**Status:** {status}
**Command:** `{test_command}`

## Test Execution

```
{output[:10000]}
```

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | {metrics.get('total', 'N/A')} |
| Passed | {metrics.get('passed', 'N/A')} |
| Failed | {metrics.get('failed', 'N/A')} |
| Duration | {metrics.get('duration', 'N/A')} |
| Exit Code | {exit_code} |
"""

    test_results_path.write_text(content)

    return {
        'feature_id': feature_id,
        'success': success,
        'exit_code': exit_code,
        'metrics': metrics,
        'output_path': str(test_results_path)
    }


def parse_test_metrics(output: str) -> dict:
    """Parse common test output formats for metrics."""
    metrics = {}

    # Vitest pattern: "Tests  42 passed (42)"
    if match := re.search(r'Tests?\s+(\d+)\s+passed', output):
        metrics['passed'] = int(match.group(1))

    # Look for failed tests
    if match := re.search(r'(\d+)\s+failed', output):
        metrics['failed'] = int(match.group(1))
    else:
        metrics['failed'] = 0

    # Calculate total
    if 'passed' in metrics:
        metrics['total'] = metrics['passed'] + metrics.get('failed', 0)

    # Vitest duration pattern: "Duration  4.72s"
    if match := re.search(r'Duration\s+([\d.]+)s', output):
        metrics['duration'] = f"{match.group(1)}s"

    # Pytest pattern: "42 passed, 3 failed in 5.23s"
    if match := re.search(r'(\d+)\s+passed(?:,\s*(\d+)\s+failed)?\s+in\s+([\d.]+)s', output):
        metrics['passed'] = int(match.group(1))
        metrics['failed'] = int(match.group(2)) if match.group(2) else 0
        metrics['total'] = metrics['passed'] + metrics['failed']
        metrics['duration'] = f"{match.group(3)}s"

    return metrics


def summary(feature_id: str, workspace: str = '.orchestrator') -> dict:
    """Generate evidence summary for a feature."""
    report = validate_evidence(feature_id, workspace)

    # Add summary info
    required_complete = sum(
        1 for item in report.get('items', [])
        if item.get('type') == 'required' and item.get('valid')
    )
    required_total = len(REQUIRED_EVIDENCE)

    optional_present = sum(
        1 for item in report.get('items', [])
        if item.get('type') == 'optional'
    )

    return {
        'feature_id': feature_id,
        'validation_passed': report.get('validation_passed', False),
        'required_evidence': f'{required_complete}/{required_total}',
        'optional_evidence': optional_present,
        'missing_required': report.get('missing_required', []),
        'items': report.get('items', [])
    }


def main():
    parser = argparse.ArgumentParser(
        description='Evidence collection utility',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s init feature-25
  %(prog)s validate feature-25
  %(prog)s collect-tests feature-25 --test-command="npm run test:run"
  %(prog)s summary feature-25
        """
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    # init
    p_init = subparsers.add_parser('init', help='Initialize evidence directory')
    p_init.add_argument('feature_id', help='Feature ID (e.g., feature-25)')
    p_init.add_argument('--workspace', default='.orchestrator',
                        help='Workspace directory path')

    # validate
    p_validate = subparsers.add_parser('validate', help='Validate evidence exists')
    p_validate.add_argument('feature_id', help='Feature ID')
    p_validate.add_argument('--workspace', default='.orchestrator',
                            help='Workspace directory path')

    # collect-tests
    p_tests = subparsers.add_parser('collect-tests', help='Run tests and save output')
    p_tests.add_argument('feature_id', help='Feature ID')
    p_tests.add_argument('--test-command', default='npm run test:run',
                         help='Test command to run')
    p_tests.add_argument('--workspace', default='.orchestrator',
                         help='Workspace directory path')

    # summary
    p_summary = subparsers.add_parser('summary', help='Generate evidence summary')
    p_summary.add_argument('feature_id', help='Feature ID')
    p_summary.add_argument('--workspace', default='.orchestrator',
                           help='Workspace directory path')

    args = parser.parse_args()

    try:
        if args.command == 'init':
            result = init_evidence(args.feature_id, args.workspace)
        elif args.command == 'validate':
            result = validate_evidence(args.feature_id, args.workspace)
        elif args.command == 'collect-tests':
            result = collect_tests(args.feature_id, args.test_command, args.workspace)
        elif args.command == 'summary':
            result = summary(args.feature_id, args.workspace)

        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()

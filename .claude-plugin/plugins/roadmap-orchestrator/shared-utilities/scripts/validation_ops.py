#!/usr/bin/env python3
"""
Pre-commit validation operations for Claude Code workflows.

Usage:
    python3 validation_ops.py type-check [--project-dir=.]
    python3 validation_ops.py test-check [--test-command="npm run test:run"]
    python3 validation_ops.py lint-check [--lint-command="npm run lint"]
    python3 validation_ops.py full-check [--project-dir=.]

Per-project overrides:
    A project can override the auto-detected commands and default timeouts
    by creating `.orchestrator/config.yaml` (preferred) or `.orchestrator/config.json`
    with a `validation:` section, e.g.:

        validation:
          type_command: "make typecheck"
          test_command: "make fitness"
          lint_command: "make lint"
          type_timeout: 180
          test_timeout: 1800
          lint_timeout: 120

    Any missing key falls back to auto-detection (type_check) or the default
    timeout. This is how projects point the orchestrator's validation gate at
    composite targets that include benchmarks, alert-rule linting, e2e, etc.
"""

import sys
import subprocess
import argparse
import json
import os
import re
from pathlib import Path
from dataclasses import dataclass, asdict, field
from typing import Optional, List


DEFAULT_TIMEOUTS = {
    # Bumped from the previous in-line values (300s test, 60s lint) so that
    # composite project targets like `make fitness` — which may run benchmarks,
    # promtool rule tests, and e2e — have room to complete. Override per-project
    # via `.orchestrator/config.yaml`.
    'type': 180,
    'test': 1800,
    'lint': 180,
}


@dataclass
class CheckResult:
    check_type: str
    passed: bool
    exit_code: int
    output: str
    error_count: int
    errors: List[str] = field(default_factory=list)


def load_validation_config(project_dir: str = '.') -> dict:
    """Load validation overrides from `.orchestrator/config.{yaml,json}`.

    Returns the dict under the `validation:` key, or an empty dict if no config
    file is present, parsing fails, or the section is absent/malformed. Callers
    merge the result over auto-detected commands and default timeouts.

    YAML support is optional. If `pyyaml` is not installed and the project uses
    a YAML config, we fall through to the JSON path; if neither is present or
    parseable, auto-detection is used.
    """
    base = Path(project_dir) / '.orchestrator'
    yaml_path = base / 'config.yaml'
    json_path = base / 'config.json'

    raw = None

    if yaml_path.exists():
        try:
            import yaml  # noqa: PLC0415 — optional dep, only needed when YAML config present
            raw = yaml.safe_load(yaml_path.read_text()) or {}
        except ImportError:
            # pyyaml unavailable — fall through to JSON path silently so projects
            # without the dep can still benefit from overrides via config.json.
            pass
        except Exception:
            # Malformed YAML shouldn't crash validation — fall through and let
            # the gate run against auto-detected defaults.
            pass

    if raw is None and json_path.exists():
        try:
            raw = json.loads(json_path.read_text()) or {}
        except Exception:
            pass

    if not isinstance(raw, dict):
        return {}

    validation = raw.get('validation', {})
    return validation if isinstance(validation, dict) else {}


def resolve_commands(project_dir: str = '.') -> dict:
    """Resolve final commands + timeouts, with config overriding detection."""
    info = detect_project_type(project_dir)
    config = load_validation_config(project_dir)

    def _pick(cfg_key: str, detected: Optional[str]) -> Optional[str]:
        value = config.get(cfg_key)
        return value if value else detected

    def _timeout(cfg_key: str, default: int) -> int:
        value = config.get(cfg_key, default)
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    return {
        'project_type': info.get('type', 'unknown'),
        'type': {
            'command': _pick('type_command', info.get('type_check')),
            'timeout': _timeout('type_timeout', DEFAULT_TIMEOUTS['type']),
        },
        'test': {
            'command': _pick('test_command', info.get('test_check')),
            'timeout': _timeout('test_timeout', DEFAULT_TIMEOUTS['test']),
        },
        'lint': {
            'command': _pick('lint_command', info.get('lint_check')),
            'timeout': _timeout('lint_timeout', DEFAULT_TIMEOUTS['lint']),
        },
    }


def detect_project_type(project_dir: str = '.') -> dict:
    """Detect project type and available commands."""
    path = Path(project_dir)

    info = {
        'type': 'unknown',
        'type_check': None,
        'test_check': None,
        'lint_check': None
    }

    # TypeScript/JavaScript
    package_json = path / 'package.json'
    if package_json.exists():
        try:
            pkg = json.loads(package_json.read_text())
            scripts = pkg.get('scripts', {})

            if (path / 'tsconfig.json').exists():
                info['type'] = 'typescript'
                info['type_check'] = 'npx tsc --noEmit'

            if 'test:run' in scripts:
                info['test_check'] = 'npm run test:run'
            elif 'test' in scripts:
                info['test_check'] = 'npm test'

            if 'lint' in scripts:
                info['lint_check'] = 'npm run lint'
        except json.JSONDecodeError:
            pass

    # Python
    elif (path / 'pyproject.toml').exists() or (path / 'setup.py').exists():
        info['type'] = 'python'
        src_dir = path / 'src'
        if src_dir.exists():
            info['type_check'] = 'python -m mypy src/'
        else:
            info['type_check'] = 'python -m mypy .'
        info['test_check'] = 'pytest'
        info['lint_check'] = 'python -m ruff check .'

    return info


def run_check(command: str, check_type: str, timeout: int = 120) -> CheckResult:
    """Run a validation check and parse results."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        output = result.stdout + result.stderr
        passed = result.returncode == 0

        # Parse errors from output
        errors = []
        error_patterns = [
            (r'error TS\d+:', 'typescript'),      # TypeScript
            (r'error:', 'general'),                # General
            (r'FAILED', 'test'),                   # Pytest/Vitest
            (r'Error:', 'eslint'),                 # ESLint
            (r'✖', 'lint'),                        # Various linters
        ]

        for line in output.split('\n'):
            for pattern, _ in error_patterns:
                if re.search(pattern, line, re.IGNORECASE):
                    stripped = line.strip()
                    if stripped and stripped not in errors:
                        errors.append(stripped)
                    break

        return CheckResult(
            check_type=check_type,
            passed=passed,
            exit_code=result.returncode,
            output=output[:5000],  # Limit output size
            error_count=len(errors),
            errors=errors[:20]  # Limit error list
        )
    except subprocess.TimeoutExpired:
        return CheckResult(
            check_type=check_type,
            passed=False,
            exit_code=-1,
            output=f'Check timed out after {timeout} seconds',
            error_count=1,
            errors=['Timeout']
        )
    except Exception as e:
        return CheckResult(
            check_type=check_type,
            passed=False,
            exit_code=-1,
            output=str(e),
            error_count=1,
            errors=[str(e)]
        )


def _skipped_result(check_type: str, reason: str) -> dict:
    return asdict(CheckResult(
        check_type=check_type,
        passed=True,
        exit_code=0,
        output=reason,
        error_count=0,
        errors=[],
    ))


def type_check(project_dir: str = '.', command: Optional[str] = None) -> dict:
    """Run type checking."""
    original_dir = os.getcwd()

    try:
        os.chdir(project_dir)
        resolved = resolve_commands('.')
        cmd = command or resolved['type']['command']
        if not cmd:
            return _skipped_result('type', 'No type checker configured for this project')
        return asdict(run_check(cmd, 'type', timeout=resolved['type']['timeout']))
    finally:
        os.chdir(original_dir)


def test_check(test_command: Optional[str] = None, project_dir: str = '.') -> dict:
    """Run tests."""
    original_dir = os.getcwd()

    try:
        os.chdir(project_dir)
        resolved = resolve_commands('.')
        cmd = test_command or resolved['test']['command']
        if not cmd:
            return _skipped_result('test', 'No test command configured for this project')
        return asdict(run_check(cmd, 'test', timeout=resolved['test']['timeout']))
    finally:
        os.chdir(original_dir)


def lint_check(lint_command: Optional[str] = None, project_dir: str = '.') -> dict:
    """Run linting."""
    original_dir = os.getcwd()

    try:
        os.chdir(project_dir)
        resolved = resolve_commands('.')
        cmd = lint_command or resolved['lint']['command']
        if not cmd:
            return _skipped_result('lint', 'No lint command configured for this project')
        return asdict(run_check(cmd, 'lint', timeout=resolved['lint']['timeout']))
    finally:
        os.chdir(original_dir)


def full_check(project_dir: str = '.') -> dict:
    """Run all checks and report combined results."""
    original_dir = os.getcwd()

    try:
        os.chdir(project_dir)
        resolved = resolve_commands('.')

        results = {
            'project_type': resolved['project_type'],
            'config_source': _config_source(project_dir),
            'all_passed': True,
            'checks': [],
            'summary': {
                'total_checks': 0,
                'passed_checks': 0,
                'failed_checks': 0,
                'total_errors': 0,
            },
        }

        for check_type in ('type', 'test', 'lint'):
            cmd = resolved[check_type]['command']
            if not cmd:
                continue
            result = run_check(cmd, check_type, timeout=resolved[check_type]['timeout'])
            results['checks'].append(asdict(result))
            results['summary']['total_checks'] += 1
            if result.passed:
                results['summary']['passed_checks'] += 1
            else:
                results['all_passed'] = False
                results['summary']['failed_checks'] += 1
            results['summary']['total_errors'] += result.error_count

        return results
    finally:
        os.chdir(original_dir)


def _config_source(project_dir: str) -> str:
    base = Path(project_dir) / '.orchestrator'
    if (base / 'config.yaml').exists():
        return str(base / 'config.yaml')
    if (base / 'config.json').exists():
        return str(base / 'config.json')
    return 'auto-detect'


def main():
    parser = argparse.ArgumentParser(
        description='Validation operations utility',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s type-check
  %(prog)s test-check --test-command="npm run test:run"
  %(prog)s lint-check
  %(prog)s full-check --project-dir=/path/to/project

Exit codes:
  0 - All checks passed
  1 - One or more checks failed
        """
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    # type-check
    p_type = subparsers.add_parser('type-check', help='Run type checking')
    p_type.add_argument('--project-dir', default='.', help='Project directory')
    p_type.add_argument('--type-command', help='Override type check command')

    # test-check
    p_test = subparsers.add_parser('test-check', help='Run tests')
    p_test.add_argument('--test-command', help='Test command to run')
    p_test.add_argument('--project-dir', default='.', help='Project directory')

    # lint-check
    p_lint = subparsers.add_parser('lint-check', help='Run linter')
    p_lint.add_argument('--lint-command', help='Lint command to run')
    p_lint.add_argument('--project-dir', default='.', help='Project directory')

    # full-check
    p_full = subparsers.add_parser('full-check', help='Run all checks')
    p_full.add_argument('--project-dir', default='.', help='Project directory')

    args = parser.parse_args()

    try:
        if args.command == 'type-check':
            result = type_check(args.project_dir, getattr(args, 'type_command', None))
        elif args.command == 'test-check':
            result = test_check(args.test_command, args.project_dir)
        elif args.command == 'lint-check':
            result = lint_check(args.lint_command, args.project_dir)
        elif args.command == 'full-check':
            result = full_check(args.project_dir)

        print(json.dumps(result, indent=2))

        # Exit with appropriate code
        if isinstance(result, dict):
            if result.get('all_passed') is False or result.get('passed') is False:
                sys.exit(1)
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()

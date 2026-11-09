#!/usr/bin/env python3
"""Resolve 20 Python-API MCP shim.

The official davinci-mcp server ships for Resolve 21+. This shim exposes the
same two stdio MCP tools (`run_script`, `run_script_unsafe`) on top of the
Python scripting API, so the DSH plugin and its 22 tools work unchanged for
Resolve 20 clients.

Environment:
  RESOLVE_SCRIPT_API  Developer/Scripting directory (macOS default below)
  RESOLVE_SCRIPT_LIB  the running Resolve's fusionscript library
  DSH_DAVINCI_PYTHON  Python executable used for the script subprocess

Each call runs the provided script in a fresh Python process with `resolve`
and `project` injected, captures stdout, and returns the official inner JSON
(`{"output": ...}` / `{"error": ...}`) as the MCP text content.
"""
import json
import os
import subprocess
import sys
import tempfile

API = os.environ.get(
    'RESOLVE_SCRIPT_API',
    '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting',
)
LIB = os.environ.get(
    'RESOLVE_SCRIPT_LIB',
    '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so',
)
PYTHON = os.environ.get('DSH_DAVINCI_PYTHON', sys.executable)

BOOTSTRAP = '''import DaVinciResolveScript as dvr
try:
    resolve = dvr.scriptapp("Resolve")
except Exception:
    resolve = None
project = resolve.GetProjectManager().GetCurrentProject() if resolve is not None else None
'''

TOOLS = [
    {
        'name': 'run_script',
        'description': 'Run a Python script against the running Resolve (sandbox-compatible body).',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'script': {'type': 'string'},
                'timeout': {'type': 'number', 'description': 'Seconds before the script is killed.'},
            },
            'required': ['script'],
        },
    },
    {
        'name': 'run_script_unsafe',
        'description': 'Run a Python script with OS access against the running Resolve.',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'script': {'type': 'string'},
                'timeout': {'type': 'number', 'description': 'Seconds before the script is killed.'},
            },
            'required': ['script'],
        },
    },
]


def execute(script, timeout):
    handle, path = tempfile.mkstemp(prefix='davinci-', suffix='.py')
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as source:
            source.write(BOOTSTRAP)
            source.write(script)
        env = dict(os.environ)
        env['RESOLVE_SCRIPT_API'] = API
        env['RESOLVE_SCRIPT_LIB'] = LIB
        modules = os.path.join(API, 'Modules')
        env['PYTHONPATH'] = modules + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
        try:
            result = subprocess.run(
                [PYTHON, path],
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired:
            return {'error': f'Script timed out after {timeout}s. Avoid long iterations; fetch only what you need.'}
        if result.returncode != 0:
            detail = (result.stderr or '').strip()
            return {'error': detail or f'Python exited with code {result.returncode}'}
        return {'output': result.stdout}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def handle(message):
    method = message.get('method')
    if method == 'initialize':
        return {
            'protocolVersion': '2024-11-05',
            'capabilities': {'tools': {}},
            'serverInfo': {'name': 'davinci-python-api', 'version': '0.1.0'},
        }
    if method == 'tools/list':
        return {'tools': TOOLS}
    if method == 'tools/call':
        params = message.get('params') or {}
        arguments = params.get('arguments') or {}
        script = arguments.get('script')
        if not isinstance(script, str):
            return {'content': [{'type': 'text', 'text': json.dumps({'error': 'missing script argument'})}]}
        try:
            timeout = float(arguments.get('timeout', 60) or 60)
        except (TypeError, ValueError):
            timeout = 60.0
        return {'content': [{'type': 'text', 'text': json.dumps(execute(script, timeout))}]}
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        result = handle(message)
        if message.get('id') is None or result is None:
            continue
        sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()

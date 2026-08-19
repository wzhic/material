#!/bin/sh
# Select a Python 3 runtime without creating a project dependency manifest.
set -eu

case "${1-}" in
  session_start.py|pre_tool_use.py)
    hook_name=$1
    ;;
  *)
    echo "unsupported governance hook entrypoint" >&2
    exit 64
    ;;
esac

hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
hook_script=$hook_dir/$hook_name

python_is_usable() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1
}

if [ -n "${PROJECT_GOVERNANCE_PYTHON-}" ] \
  && [ -x "$PROJECT_GOVERNANCE_PYTHON" ] \
  && python_is_usable "$PROJECT_GOVERNANCE_PYTHON"; then
  exec "$PROJECT_GOVERNANCE_PYTHON" "$hook_script"
fi

if path_python=$(command -v python3 2>/dev/null) \
  && [ -x "$path_python" ] \
  && python_is_usable "$path_python"; then
  exec "$path_python" "$hook_script"
fi

bundled_python=${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3
if [ -x "$bundled_python" ] && python_is_usable "$bundled_python"; then
  exec "$bundled_python" "$hook_script"
fi

echo "no usable Python 3.9+ runtime found; set PROJECT_GOVERNANCE_PYTHON" >&2
exit 69

#!/usr/bin/env bash
# AI-generated. See PROMPT.md for the prompts and model used.
set -euo pipefail

if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is required to build gdrive-open. Install it from https://docs.astral.sh/uv/" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec uv run --no-project --script "${script_dir}/build-binary.py" "$@"

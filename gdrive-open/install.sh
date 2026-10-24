#!/usr/bin/env bash
# AI-generated. See PROMPT.md for the prompts and model used.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--bin-dir DIR] [--client-config PATH]

Build gdrive-open for this OS/CPU and install it (requires uv).
  --bin-dir DIR         Executable directory (default: ~/.local/bin)
  --client-config PATH  Desktop OAuth client JSON to bundle
  -h, --help            Show this help

Use Bash on macOS/Linux or Git Bash with native Windows uv on Windows.
USAGE
}

bin_dir="${HOME}/.local/bin"
build_args=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --bin-dir|--client-config)
      if [[ "$#" -lt 2 || -z "$2" || "$2" == --* ]]; then
        printf 'Error: %s requires a value.\n' "$1" >&2
        exit 2
      fi
      if [[ "$1" == --bin-dir ]]; then
        bin_dir="$2"
      else
        build_args+=("--client-config" "$2")
      fi
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Error: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
temporary_dir="$(mktemp -d)"
staged_binary=''
cleanup() {
  rm -rf -- "$temporary_dir"
  if [[ -n "$staged_binary" ]]; then rm -f -- "$staged_binary"; fi
}
trap cleanup EXIT

"$script_dir/build-binary.sh" --executable-path-file "$temporary_dir/executable-path" ${build_args[@]+"${build_args[@]}"}
IFS= read -r executable < "$temporary_dir/executable-path"
if command -v cygpath >/dev/null 2>&1; then
  executable="$(cygpath -u "$executable")"
  bin_dir="$(cygpath -u "$bin_dir")"
fi
if [[ ! -f "$executable" ]]; then
  echo 'Error: the build did not produce an executable.' >&2
  exit 1
fi
executable_name="$(basename -- "$executable")"
case "$executable_name" in
  gdrive-open|gdrive-open.exe) ;;
  *) echo 'Error: unexpected executable name from builder.' >&2; exit 1 ;;
esac
mkdir -p -- "$bin_dir"
bin_dir="$(cd -- "$bin_dir" && pwd -P)"
destination="$bin_dir/$executable_name"
if [[ -d "$destination" ]]; then
  printf 'Error: installation destination is a directory: %s\n' "$destination" >&2
  exit 1
fi
staged_binary="$(mktemp "$bin_dir/.gdrive-open.XXXXXX")"
cp -- "$executable" "$staged_binary"
chmod 755 "$staged_binary"
mv -f -- "$staged_binary" "$destination"
staged_binary=''
printf 'Installed: %s\n' "$destination"
case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *) printf 'Add this directory to your shell PATH:\n  export PATH=%q:"$PATH"\n' "$bin_dir" ;;
esac

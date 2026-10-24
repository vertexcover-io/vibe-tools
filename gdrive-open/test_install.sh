#!/usr/bin/env bash
# AI-generated. See PROMPT.md for the prompts and model used.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
test -f "$script_dir/install.sh" || { echo "FAIL: install.sh is missing" >&2; exit 1; }
cp "$script_dir/install.sh" "$fixture/install.sh"
cat > "$fixture/build-binary.sh" <<'BUILDER'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAIL_BUILD:-0}" == 1 ]]; then exit 42; fi
[[ "$1" == --executable-path-file ]]
manifest="$2"
shift 2
if [[ "$#" -gt 0 ]]; then
  [[ "$1" == --client-config && "$2" == '/client config/desktop.json' && "$#" == 2 ]]
fi
printf '%s\n' "$FAKE_EXECUTABLE" > "$manifest"
BUILDER
chmod +x "$fixture/build-binary.sh"
mkdir -p "$fixture/build output" "$fixture/bin dir"
export FAKE_EXECUTABLE="$fixture/build output/gdrive-open"
printf '#!/usr/bin/env bash\necho installed-ok\n' > "$FAKE_EXECUTABLE"
chmod +x "$FAKE_EXECUTABLE"
cd /private/tmp 2>/dev/null || cd /tmp
bash "$fixture/install.sh" --bin-dir "$fixture/bin dir" --client-config '/client config/desktop.json'
[[ "$("$fixture/bin dir/gdrive-open")" == installed-ok ]]
printf 'old executable\n' > "$fixture/bin dir/gdrive-open"
if FAIL_BUILD=1 bash "$fixture/install.sh" --bin-dir "$fixture/bin dir"; then
  echo 'FAIL: failed build was accepted' >&2; exit 1
fi
[[ "$(cat "$fixture/bin dir/gdrive-open")" == 'old executable' ]]
if bash "$fixture/install.sh" --bin-dir ''; then
  echo 'FAIL: empty destination was accepted' >&2; exit 1
fi
export FAKE_EXECUTABLE="$fixture/build output/gdrive-open.exe"
printf '#!/usr/bin/env bash\necho windows-name-ok\n' > "$FAKE_EXECUTABLE"
bash "$fixture/install.sh" --bin-dir "$fixture/bin dir"
[[ "$("$fixture/bin dir/gdrive-open.exe")" == windows-name-ok ]]
echo 'Installer checks passed.'

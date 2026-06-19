#!/usr/bin/env -S uv run --script
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""electron-mod: inspect, mod, repack and re-sign ANY installed Electron app on macOS.

Inspect, mod, and re-sign an arbitrary Electron .app. Two subcommands:

  inspect  Emit structured JSON describing the app: asar location, fuses, signing,
           main entry, preloads, native modules, integrity block. This is what a coding
           agent reads to understand the app before planning a mod.

  build    Copy the app to a modded sibling, asar-extract, apply mods from a mods/ dir,
           repack (keeping *.node unpacked), fix asar-integrity hash, neuter auto-update,
           and re-sign with a STABLE self-signed identity (so cookie/Keychain state
           survives rebuilds). Falls back to flipping the integrity fuse off if launch
           verification fails.

The hard-won learnings baked into the pipeline:
  - asar integrity hash is SHA256(asar.getRawHeader(file).headerString).
  - native modules (*.node) MUST stay unpacked in app.asar.unpacked/.
  - renderer mods are inlined into a sandboxed preload (no fs/require at runtime).
  - a STABLE signing identity (not ad-hoc) keeps the Safe Storage Keychain entry stable
    so logins/cookies persist across rebuilds.

Requires: macOS, node + npx (@electron/asar, @electron/fuses), codesign, openssl, security.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


def fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd: list[str], *, capture: bool = False, cwd: Path | None = None) -> str:
    result = subprocess.run(
        cmd,
        check=True,
        text=True,
        capture_output=capture,
        cwd=str(cwd) if cwd else None,
    )
    return result.stdout if capture else ""


def require_macos() -> None:
    if sys.platform != "darwin":
        fail("this tool only runs on macOS")


def require_tools(*, signing: bool) -> None:
    needed = ["node", "npx"]
    if signing:
        needed += ["codesign", "openssl", "security"]
    for tool in needed:
        if shutil.which(tool) is None:
            fail(f"required tool not found on PATH: {tool}")


# --- bundle discovery ---------------------------------------------------------


@dataclass(frozen=True)
class Bundle:
    """An Electron .app bundle. All app-specific paths are DISCOVERED, not hardcoded."""

    app: Path

    @property
    def contents(self) -> Path:
        return self.app / "Contents"

    @property
    def resources(self) -> Path:
        return self.contents / "Resources"

    @property
    def info_plist(self) -> Path:
        return self.contents / "Info.plist"

    @property
    def macos_dir(self) -> Path:
        return self.contents / "MacOS"

    def plist(self) -> dict:
        with self.info_plist.open("rb") as fh:
            return plistlib.load(fh)

    def version(self) -> str:
        return str(self.plist().get("CFBundleShortVersionString", "unknown"))

    def executable_name(self) -> str:
        name = self.plist().get("CFBundleExecutable")
        if name:
            return str(name)
        # fallback: the single file in Contents/MacOS
        exes = [p for p in self.macos_dir.iterdir() if p.is_file()]
        if len(exes) == 1:
            return exes[0].name
        fail("could not determine the main executable name")
        raise AssertionError  # unreachable

    def main_binary(self) -> Path:
        return self.macos_dir / self.executable_name()

    def asar(self) -> Path | None:
        """Locate app.asar. Most apps use Resources/app.asar; some nest it."""
        primary = self.resources / "app.asar"
        if primary.exists():
            return primary
        # some apps ship Resources/app/ (unpacked) or a differently named asar
        for candidate in self.resources.glob("*.asar"):
            if candidate.name != "electron.asar":
                return candidate
        return None

    def unpacked_dir(self) -> Path | None:
        asar = self.asar()
        if asar is None:
            return None
        unpacked = asar.parent / (asar.name + ".unpacked")
        return unpacked if unpacked.exists() else None

    def update_yml(self) -> Path | None:
        for name in ("app-update.yml", "app-update.yaml"):
            p = self.resources / name
            if p.exists():
                return p
        return None

    def integrity_block(self) -> dict | None:
        return self.plist().get("ElectronAsarIntegrity")


# --- node helpers (asar header hash + fuse flip) ------------------------------

_HEADER_HASH_JS = """
const crypto = require("crypto");
const asar = require("@electron/asar");
const raw = asar.getRawHeader(process.argv[1]);
process.stdout.write(crypto.createHash("sha256").update(raw.headerString).digest("hex"));
"""


def node_dir() -> Path:
    """A temp dir with @electron/asar installed, reused across calls."""
    cache = Path(tempfile.gettempdir()) / "electron-mod-node"
    if not (cache / "node_modules" / "@electron" / "asar").exists():
        cache.mkdir(parents=True, exist_ok=True)
        print("  installing @electron/asar (one-time)...", file=sys.stderr)
        run(["npm", "install", "--silent", "@electron/asar"], cwd=cache)
    return cache


def asar_header_hash(asar_path: Path) -> str:
    out = run(
        ["node", "--eval", _HEADER_HASH_JS, str(asar_path)],
        capture=True,
        cwd=node_dir(),
    )
    return out.strip()


def asar_extract(asar_path: Path, dest: Path) -> None:
    run(["npx", "--yes", "@electron/asar", "extract", str(asar_path), str(dest)])


def asar_list(asar_path: Path) -> list[str]:
    out = run(["npx", "--yes", "@electron/asar", "list", str(asar_path)], capture=True)
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def asar_pack(src: Path, asar_path: Path) -> None:
    # Native modules (*.node) must stay UNPACKED in app.asar.unpacked/, matching the
    # original build. Packing them inside the asar breaks main-process native module
    # loading, which silently aborts IPC handler registration.
    run([
        "npx", "--yes", "@electron/asar", "pack", str(src), str(asar_path),
        "--unpack", "*.node",
    ])


def read_fuses(app: Path) -> dict[str, bool]:
    out = run(["npx", "--yes", "@electron/fuses", "read", "--app", str(app)], capture=True)
    fuses: dict[str, bool] = {}
    for line in out.splitlines():
        line = line.strip()
        if " is " in line:
            name, _, state = line.partition(" is ")
            fuses[name.strip()] = state.strip().lower() == "enabled"
    return fuses


def disable_asar_integrity_fuse(app: Path) -> None:
    run([
        "npx", "--yes", "@electron/fuses", "write",
        "--app", str(app),
        "EnableEmbeddedAsarIntegrityValidation=off",
    ])


# --- inspect ------------------------------------------------------------------


def read_package_json(extracted: Path) -> dict:
    pkg = extracted / "package.json"
    if not pkg.exists():
        return {}
    try:
        return json.loads(pkg.read_text(encoding="utf-8"))
    except Exception:
        return {}


def find_preloads(extracted: Path) -> list[str]:
    """Heuristic: files named *preload*.js anywhere in the extracted app."""
    out: list[str] = []
    for p in extracted.rglob("*preload*.js"):
        if "node_modules" in p.parts:
            continue
        out.append(str(p.relative_to(extracted)))
    return sorted(out)


def find_native_modules(extracted: Path) -> list[str]:
    return sorted(
        str(p.relative_to(extracted)) for p in extracted.rglob("*.node")
    )


def signing_info(app: Path) -> dict:
    proc = subprocess.run(
        ["codesign", "-dv", "--verbose=4", str(app)],
        capture_output=True, text=True,
    )
    text = proc.stderr  # codesign prints to stderr
    authority = re.findall(r"Authority=(.+)", text)
    ident = re.search(r"Identifier=(.+)", text)
    team = re.search(r"TeamIdentifier=(.+)", text)
    return {
        "identifier": ident.group(1).strip() if ident else None,
        "authorities": [a.strip() for a in authority],
        "team_identifier": team.group(1).strip() if team else None,
        "ad_hoc": "linker-signed" in text or not authority,
    }


def inspect(args: argparse.Namespace) -> None:
    require_macos()
    require_tools(signing=False)

    bundle = Bundle(Path(args.app).resolve())
    if not bundle.app.exists():
        fail(f"app not found: {bundle.app}")

    asar = bundle.asar()
    fuses = read_fuses(bundle.app)
    integrity = bundle.integrity_block()
    plist = bundle.plist()

    report: dict = {
        "app": str(bundle.app),
        "name": bundle.app.stem,
        "version": bundle.version(),
        "executable": bundle.executable_name(),
        "main_binary": str(bundle.main_binary()),
        "bundle_id": plist.get("CFBundleIdentifier"),
        "asar": str(asar) if asar else None,
        "asar_unpacked": str(bundle.unpacked_dir()) if bundle.unpacked_dir() else None,
        "fuses": fuses,
        "asar_integrity_enabled": fuses.get(
            "EnableEmbeddedAsarIntegrityValidation", False
        ),
        "only_load_app_from_asar": fuses.get("OnlyLoadAppFromAsar", False),
        "integrity_block": integrity,
        "signing": signing_info(bundle.app),
        "update_yml": str(bundle.update_yml()) if bundle.update_yml() else None,
    }

    # Peek inside the asar (without fully extracting) to surface main entry + preloads.
    if asar is not None:
        if args.deep:
            with tempfile.TemporaryDirectory() as tmp:
                extracted = Path(tmp) / "app"
                asar_extract(asar, extracted)
                pkg = read_package_json(extracted)
                report["package_main"] = pkg.get("main")
                report["package_name"] = pkg.get("name")
                report["preloads"] = find_preloads(extracted)
                report["native_modules"] = find_native_modules(extracted)
        else:
            entries = asar_list(asar)
            report["asar_entry_count"] = len(entries)
            report["preloads"] = sorted(
                e.lstrip("/") for e in entries
                if "preload" in e.lower() and e.endswith(".js")
                and "node_modules" not in e
            )

    print(json.dumps(report, indent=2))


# --- mods ---------------------------------------------------------------------


def apply_mods(extracted: Path, mods_dir: Path, *, renderer_targets: list[str]) -> list[str]:
    """Inject each mod under mods_dir. Returns names of applied mods.

    A mod is a folder containing any of:
      - renderer.css / renderer.js  -> inlined into each renderer target preload at startup
      - patch.py                    -> run as `python patch.py <extracted_app_dir>` for
                                       arbitrary main-process source edits
    """
    if not mods_dir.exists():
        return []
    applied: list[str] = []
    css_blocks: list[str] = []
    js_blocks: list[str] = []

    mod_dirs = (p for p in mods_dir.iterdir() if p.is_dir() and not p.name.startswith("."))
    for mod in sorted(mod_dirs):
        used = False
        css = mod / "renderer.css"
        if css.exists():
            css_blocks.append(css.read_text(encoding="utf-8"))
            used = True
        js = mod / "renderer.js"
        if js.exists():
            js_blocks.append(js.read_text(encoding="utf-8"))
            used = True
        patch = mod / "patch.py"
        if patch.exists():
            run([sys.executable, str(patch), str(extracted)])
            used = True
        if used:
            applied.append(mod.name)

    if css_blocks or js_blocks:
        if not renderer_targets:
            print(
                "  warning: renderer mods present but no renderer target resolved; "
                "pass --renderer <relative/preload.js>",
                file=sys.stderr,
            )
        for target in renderer_targets:
            inject_into_renderer(extracted, target, css_blocks, js_blocks)
    return applied


def inject_into_renderer(
    extracted: Path, target_rel: str, css_blocks: list[str], js_blocks: list[str]
) -> None:
    """Append a self-contained loader to a renderer preload.

    The loader is fully inlined (no fs/path/require at runtime) so it can never throw
    out of the preload under contextIsolation. CSS is injected as a <style> once the DOM
    exists; renderer JS runs in a guarded try/catch.
    """
    target = extracted / target_rel
    if not target.exists():
        print(f"  warning: renderer target not found: {target_rel}", file=sys.stderr)
        return

    combined_css = "\n".join(css_blocks)
    combined_js = "\n".join(js_blocks)
    loader = (
        "\n;(function(){try{\n"
        "  if (typeof document === 'undefined') return;\n"
        f"  var css = {json.dumps(combined_css)};\n"
        "  var apply = function(){ try {\n"
        "    if (css) { var el = document.createElement('style');\n"
        "      el.setAttribute('data-electron-mod','1');\n"
        "      el.textContent = css; (document.head||document.documentElement).appendChild(el); }\n"
        f"    {combined_js}\n"
        "  } catch (e) { console.error('[electron-mod] apply', e); } };\n"
        "  if (document.readyState === 'loading')\n"
        "    document.addEventListener('DOMContentLoaded', apply);\n"
        "  else apply();\n"
        "} catch (e) { console.error('[electron-mod] loader', e); }})();\n"
    )
    with target.open("a", encoding="utf-8") as fh:
        fh.write(loader)
    print(f"  injected into renderer: {target_rel}")


# --- auto-update --------------------------------------------------------------


def disable_auto_update(bundle: Bundle) -> None:
    yml = bundle.update_yml()
    if yml is not None:
        yml.write_text("provider: generic\nurl: 'http://127.0.0.1:0/blocked'\n")
        print("  neutered auto-update config")


# --- plist integrity ----------------------------------------------------------


def update_integrity_hash(bundle: Bundle, asar_rel: str, new_hash: str) -> bool:
    """Rewrite the ElectronAsarIntegrity hash for the modded asar.

    Plist keys vary by app (usually 'Resources/app.asar', but the asar may be named
    or nested differently). Match by exact key first, then by basename against the
    existing keys, so we update the right entry instead of guessing. Returns True if
    an entry was written.
    """
    data = bundle.plist()
    integrity = data.get("ElectronAsarIntegrity")
    if not integrity:
        return False

    key = asar_rel if asar_rel in integrity else None
    if key is None:
        target = Path(asar_rel).name
        for k in integrity:
            if Path(k).name == target:
                key = k
                break
    if key is None:
        # last resort: if exactly one entry exists, it must be our asar
        if len(integrity) == 1:
            key = next(iter(integrity))
        else:
            return False

    integrity[key]["hash"] = new_hash
    integrity[key]["algorithm"] = "SHA256"
    data["ElectronAsarIntegrity"] = integrity
    with bundle.info_plist.open("wb") as fh:
        plistlib.dump(data, fh)
    return True


# --- signing ------------------------------------------------------------------

LOGIN_KEYCHAIN = Path.home() / "Library" / "Keychains" / "login.keychain-db"


def signing_identity_exists(identity: str) -> bool:
    out = subprocess.run(
        ["security", "find-identity", "-v", "-p", "codesigning"],
        capture_output=True, text=True,
    ).stdout
    return identity in out


def ensure_signing_identity(identity: str) -> None:
    """Create a stable self-signed code-signing identity if missing.

    Ad-hoc signing gives the app a new identity each build, so macOS denies it the
    Keychain key that decrypts the app's stored cookies (Safe Storage) -> re-login every
    launch. A STABLE identity keeps the same Keychain entry, so login persists.
    """
    if signing_identity_exists(identity):
        return
    print(f"  creating stable signing identity '{identity}' (one-time)...")
    pw = "electronmod"
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        cnf = d / "cert.cnf"
        cnf.write_text(
            "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n"
            f"[dn]\nCN={identity}\n"
            "[v3]\nbasicConstraints=critical,CA:false\n"
            "keyUsage=critical,digitalSignature\n"
            "extendedKeyUsage=critical,codeSigning\n"
        )
        cert, key, p12 = d / "cert.pem", d / "key.pem", d / "id.p12"
        run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", str(key),
             "-out", str(cert), "-days", "3650", "-nodes", "-config", str(cnf)])
        # -legacy: Apple's importer rejects OpenSSL 3's newer PKCS#12 MAC.
        run(["openssl", "pkcs12", "-export", "-legacy", "-inkey", str(key), "-in", str(cert),
             "-out", str(p12), "-passout", f"pass:{pw}", "-name", identity])
        run(["security", "import", str(p12), "-k", str(LOGIN_KEYCHAIN),
             "-P", pw, "-T", "/usr/bin/codesign"])
        run(["security", "add-trusted-cert", "-p", "codeSign",
             "-k", str(LOGIN_KEYCHAIN), str(cert)])
    if not signing_identity_exists(identity):
        fail("failed to create a usable signing identity")
    print(f"  signing identity '{identity}' ready")


def sign_app(app: Path, identity: str) -> None:
    ensure_signing_identity(identity)
    run(["codesign", "--remove-signature", str(app)])
    run(["codesign", "--force", "--deep", "--sign", identity, str(app)])


def clear_quarantine(app: Path) -> None:
    subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(app)], check=False)


def verify_codesign(app: Path) -> bool:
    proc = subprocess.run(["codesign", "--verify", "--deep", str(app)], capture_output=True)
    return proc.returncode == 0


# --- pipeline -----------------------------------------------------------------


def default_dest(source: Path) -> Path:
    return source.with_name(f"{source.stem}-Modded.app")


def default_identity(source: Path) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", source.stem.lower()).strip("-")
    return f"{slug}-mod-signing"


def build(args: argparse.Namespace) -> None:
    require_macos()
    require_tools(signing=not args.no_sign)

    source = Bundle(Path(args.source).resolve())
    dest_path = Path(args.dest).resolve() if args.dest else default_dest(source.app)
    dest = Bundle(dest_path)
    mods_dir = Path(args.mods).resolve()
    identity = args.identity or default_identity(source.app)

    if not source.app.exists():
        fail(f"source app not found: {source.app}")
    source_asar = source.asar()
    if source_asar is None:
        fail(f"no app.asar found under {source.resources} — is this an Electron app?")

    print(f"source : {source.app}  (v{source.version()})")
    print(f"dest   : {dest.app}")
    print(f"mods   : {mods_dir}")
    print(f"ident  : {identity}")

    fuses = read_fuses(source.app)
    fuse_on = fuses.get("EnableEmbeddedAsarIntegrityValidation", False)
    # Trust the plist block too: if the fuse read drifts/fails it defaults to False,
    # but a present ElectronAsarIntegrity block still means the hash must be rewritten.
    has_integrity_block = source.integrity_block() is not None
    integrity_on = fuse_on or has_integrity_block
    print(f"asar integrity: {'ENABLED' if integrity_on else 'disabled'}"
          f" (fuse={'on' if fuse_on else 'off'}, plist_block={'yes' if has_integrity_block else 'no'})")

    if dest.app.exists():
        print("removing existing dest...")
        shutil.rmtree(dest.app)

    print("copying bundle...")
    shutil.copytree(source.app, dest.app, symlinks=True)

    dest_asar = dest.asar()
    if dest_asar is None:
        fail("copied bundle lost its app.asar (unexpected)")
    asar_rel = str(dest_asar.relative_to(dest.contents))

    renderer_targets = list(args.renderer or [])

    with tempfile.TemporaryDirectory() as tmp:
        extracted = Path(tmp) / "app"
        print("extracting app.asar...")
        asar_extract(dest_asar, extracted)

        # If no renderer target was given, fall back to the unique content preload guess.
        if not renderer_targets:
            renderer_targets = auto_renderer_targets(extracted)
            if renderer_targets:
                print(f"  auto-selected renderer target(s): {', '.join(renderer_targets)}")

        print("applying mods...")
        applied = apply_mods(extracted, mods_dir, renderer_targets=renderer_targets)
        print(f"  applied: {', '.join(applied) if applied else '(none)'}")

        print("repacking app.asar...")
        dest_asar.unlink()
        asar_pack(extracted, dest_asar)

    if integrity_on:
        new_hash = asar_header_hash(dest_asar)
        print(f"new integrity hash: {new_hash}")
        if not update_integrity_hash(dest, asar_rel, new_hash):
            print("  warning: no ElectronAsarIntegrity entry matched the asar; the app may "
                  "refuse to launch with the integrity fuse on (will rely on fuse fallback)")
        else:
            written = (dest.integrity_block() or {})
            ok_written = any(e.get("hash") == new_hash for e in written.values())
            print(f"  integrity hash written to Info.plist: {'OK' if ok_written else 'MISMATCH'}")

    disable_auto_update(dest)

    if args.no_sign:
        print("skipping signing (--no-sign)")
        print(f"\ndone (unsigned). launch with:  open {dest.app}")
        return

    print("re-signing with stable identity...")
    sign_app(dest.app, identity)
    clear_quarantine(dest.app)

    ok = verify_codesign(dest.app)
    print(f"codesign verify: {'OK' if ok else 'FAILED'}")

    if not ok and integrity_on and not args.no_fuse_fallback:
        print("verification failed; flipping asar-integrity fuse OFF and re-signing...")
        disable_asar_integrity_fuse(dest.app)
        sign_app(dest.app, identity)
        clear_quarantine(dest.app)
        ok = verify_codesign(dest.app)
        print(f"codesign verify (after fuse flip): {'OK' if ok else 'FAILED'}")

    print(f"\ndone. launch with:  open {dest.app}")
    print("if it refuses to open, check Console.app logs for code-signing or asar errors.")


def auto_renderer_targets(extracted: Path) -> list[str]:
    """Best-effort guess of the content-renderer preload when none was specified.

    Prefers a single preload that looks like the main content view. Returns [] when it
    cannot disambiguate — callers should pass --renderer explicitly in that case.
    """
    preloads = find_preloads(extracted)
    if len(preloads) == 1:
        return preloads
    # prefer ones whose path hints at the primary content/tab/browser view
    for hint in ("tab_browser_view", "browser_view", "renderer/main", "main_window"):
        matches = [p for p in preloads if hint in p]
        if len(matches) == 1:
            return matches
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_inspect = sub.add_parser("inspect", help="emit JSON describing an Electron app")
    p_inspect.add_argument("app", help="path to the .app bundle")
    p_inspect.add_argument(
        "--deep", action="store_true",
        help="extract the asar to list preloads, native modules, and package.main",
    )
    p_inspect.set_defaults(func=inspect)

    p_build = sub.add_parser("build", help="build a modded, re-signed copy")
    p_build.add_argument("source", help="path to the original .app bundle")
    p_build.add_argument("--dest", default=None, help="path for the modded copy (default: <name>-Modded.app)")
    p_build.add_argument("--mods", required=True, help="path to the mods directory")
    p_build.add_argument(
        "--renderer", action="append", default=None,
        help="relative path of a preload to inject renderer mods into (repeatable). "
             "If omitted, the tool tries to auto-select one.",
    )
    p_build.add_argument("--identity", default=None, help="signing identity CN (default derived from app name)")
    p_build.add_argument("--no-sign", action="store_true", help="skip re-signing entirely")
    p_build.add_argument(
        "--no-fuse-fallback", action="store_true",
        help="do not disable the integrity fuse even if launch verification fails",
    )
    p_build.set_defaults(func=build)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

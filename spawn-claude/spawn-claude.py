# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Spawn another Claude Code session with a pluggable surface, mode, and context.

Three independent axes:
  --surface  where the session runs   (tmux | cmux | ghostty | terminal | headless | auto)
  --mode     how it runs              (interactive | headless)
  --context  what it starts with      (fresh | summary | fork)

Fork delegates to Claude's native `--fork-session`: it resumes the parent into a
fresh session id and auto-sends `/rewind` so you pick the branch point in the new
session's own UI. The parent session is never mutated.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal

Surface = Literal["tmux", "cmux", "ghostty", "terminal", "headless"]
Mode = Literal["interactive", "headless"]
Context = Literal["fresh", "summary", "fork"]

PROJECTS_DIR = Path.home() / ".claude" / "projects"


def encode_cwd(cwd: Path) -> str:
    """Claude encodes a project path by replacing every non-alphanumeric char with '-'."""
    return "".join(c if c.isalnum() else "-" for c in str(cwd))


def transcript_dir(cwd: Path) -> Path:
    return PROJECTS_DIR / encode_cwd(cwd)


def latest_session_id(cwd: Path) -> str | None:
    """The live/parent session: the real transcript with the most recent message.

    Ranked by the timestamp of the last user/assistant message (not file mtime),
    so tiny metadata sidecars never win over the genuine transcript.
    """
    d = transcript_dir(cwd)
    if not d.is_dir():
        return None
    ranked: list[tuple[str, str]] = []  # (last_ts, session_id)
    for f in d.glob("*.jsonl"):
        last_ts = _last_message_ts(f)
        if last_ts:
            ranked.append((last_ts, f.stem))
    if not ranked:
        return None
    ranked.sort(reverse=True)
    return ranked[0][1]


def _last_message_ts(jsonl: Path) -> str | None:
    """Timestamp of the last user/assistant message, or None if the file has none."""
    last: str | None = None
    try:
        with jsonl.open() as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("type") in ("user", "assistant") and rec.get("timestamp"):
                    last = rec["timestamp"]
    except OSError:
        return None
    return last


@dataclass(frozen=True)
class Message:
    uuid: str
    role: str
    timestamp: str
    preview: str


def read_messages(session_id: str, cwd: Path) -> list[Message]:
    jsonl = transcript_dir(cwd) / f"{session_id}.jsonl"
    out: list[Message] = []
    with jsonl.open() as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("type") not in ("user", "assistant"):
                continue
            msg_uuid = rec.get("uuid")
            if not msg_uuid:
                continue
            out.append(
                Message(
                    uuid=msg_uuid,
                    role=rec.get("type", "?"),
                    timestamp=(rec.get("timestamp") or "")[:19],
                    preview=_preview(rec),
                )
            )
    return out


def _preview(rec: dict) -> str:
    content = (rec.get("message") or {}).get("content")
    text = ""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text += block.get("text", "")
    return " ".join(text.split())[:80]


def build_summary_prompt(parent_id: str, cwd: Path, task: str) -> str:
    msgs = read_messages(parent_id, cwd)
    recent = msgs[-20:]
    lines = [f"[{m.role}] {m.preview}" for m in recent if m.preview]
    transcript = "\n".join(lines)
    return (
        "You are continuing work spawned from a parent Claude Code session.\n"
        "Recent parent context (most recent messages):\n"
        f"{transcript}\n\n"
        f"Your task:\n{task}"
    )


def claude_argv(
    *,
    mode: Mode,
    context: Context,
    task: str,
    cwd: Path,
    parent_id: str | None,
    model: str | None,
    extra: list[str],
) -> list[str]:
    argv: list[str] = ["claude"]
    if mode == "headless":
        argv.append("-p")
    if model:
        argv += ["--model", model]

    if context == "fork":
        if not parent_id:
            raise RuntimeError("fork requires a parent session id (none detected)")
        # Native fork: resume the parent into a new session id. /rewind is sent
        # afterwards (see SEND_REWIND), so no prompt is launched here — the task
        # comes after the user picks a branch point.
        argv += ["--resume", parent_id, "--fork-session"]
        argv += extra
        return argv
    elif context == "summary":
        if not parent_id:
            raise RuntimeError("summary requires a parent session id (none detected)")
        prompt = build_summary_prompt(parent_id, cwd, task)
    else:
        prompt = task

    argv += extra
    if prompt:
        argv.append(prompt)
    return argv


# --- surfaces: each takes the claude argv and launches it somewhere ---------

LaunchFn = Callable[[list[str], Path], "subprocess.CompletedProcess | None"]

# In fork mode, send `/rewind` into the new session after it boots so the user
# picks the branch point in the session's own UI. Surfaces that can inject
# keystrokes do so; others print an instruction (see note_rewind).
SEND_REWIND = False

# Seconds to wait for `claude` to boot before sending `/rewind` keystrokes.
REWIND_BOOT_DELAY = 2.5


def note_rewind() -> None:
    if SEND_REWIND:
        print("→ forked session opened; sending /rewind to pick a branch point")


def _note_rewind_manual() -> None:
    """For surfaces that can't inject keystrokes: tell the user to run /rewind."""
    if SEND_REWIND:
        print("→ forked session opened; type /rewind in it to pick a branch point")


def launch_headless(argv: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(argv, cwd=cwd, text=True)


TmuxTarget = Literal["window", "split-h", "split-v", "session"]

# Where a tmux session lands. Set from --tmux-target before the surface runs.
TMUX_TARGET: TmuxTarget = "window"


def _tmux(*args: str) -> str:
    """Run a tmux command, returning stdout (with -P/-F it prints a target id)."""
    return subprocess.run(
        ["tmux", *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def _tmux_wait_ready(target: str, timeout: float = 30.0) -> bool:
    """Poll the pane until claude's TUI prompt is up, so /rewind isn't dropped while
    the session is still booting. Returns True once ready (or False on timeout)."""
    deadline = timeout
    while deadline > 0:
        screen = subprocess.run(
            ["tmux", "capture-pane", "-p", "-t", target],
            capture_output=True, text=True,
        ).stdout
        if "Model:" in screen or "auto mode" in screen:
            return True
        subprocess.run(["sleep", "0.5"], check=False)
        deadline -= 0.5
    return False


def _tmux_send_rewind(target: str) -> None:
    """Once the pane's claude is up, send `/rewind` keystrokes to it."""
    if not SEND_REWIND:
        return
    if _tmux_wait_ready(target):
        subprocess.run(["tmux", "send-keys", "-t", target, "/rewind", "Enter"], check=False)
        note_rewind()
    else:
        _note_rewind_manual()


def launch_tmux(argv: list[str], cwd: Path) -> None:
    if not os.environ.get("TMUX"):
        raise RuntimeError("tmux surface requires running inside a tmux session ($TMUX unset)")
    cmd = shlex.join(argv)
    fmt = "#{pane_id}"

    if TMUX_TARGET == "window":
        # A new window is a new tab in the current session.
        pane = _tmux("new-window", "-P", "-F", fmt, "-c", str(cwd),
                     "-n", "claude-child", cmd)
    elif TMUX_TARGET == "split-h":
        # Side-by-side split of the current pane.
        pane = _tmux("split-window", "-h", "-P", "-F", fmt, "-c", str(cwd), cmd)
    elif TMUX_TARGET == "split-v":
        # Stacked split of the current pane.
        pane = _tmux("split-window", "-v", "-P", "-F", fmt, "-c", str(cwd), cmd)
    else:  # session: a fresh detached session, then switch the client to it.
        session = _tmux("new-session", "-d", "-P", "-F", "#{session_name}",
                        "-c", str(cwd), "-s", "claude-child", cmd)
        pane = f"{session}:"  # target the session's active pane for send-keys
        subprocess.run(["tmux", "switch-client", "-t", session], check=False)

    _tmux_send_rewind(pane)


CmuxTarget = Literal["tab", "window", "workspace"]

# Where a cmux session lands. Set from --cmux-target before the surface runs.
CMUX_TARGET: CmuxTarget = "tab"


def _cmux_bin() -> str:
    cmux = shutil.which("cmux") or "/Applications/cmux.app/Contents/Resources/bin/cmux"
    if not Path(cmux).exists():
        raise RuntimeError("cmux CLI not found")
    return cmux


def _parse_cmux_ref(output: str, kind: str) -> str | None:
    """Extract a `kind:N` ref (e.g. 'surface:32') from cmux 'OK surface:32 …' output."""
    for token in output.split():
        if token.startswith(f"{kind}:"):
            return token
    return None


def _cmux(cmux: str, *args: str) -> str:
    return subprocess.run(
        [cmux, *args], check=True, capture_output=True, text=True
    ).stdout


# cmux split directions: a split makes a new surface beside/below the caller's.
# horizontal = side-by-side (right); vertical = stacked (down).
_SPLIT_DIR: dict[str, str] = {"split-h": "right", "split-v": "down"}


def _cmux_wait_ready(cmux: str, surface: str, timeout: float = 30.0) -> bool:
    """Poll the surface until claude's TUI prompt is up, so /rewind isn't dropped
    while the session is still booting. Returns True once ready (or False on timeout)."""
    deadline = timeout
    while deadline > 0:
        try:
            screen = _cmux(cmux, "read-screen", "--surface", surface)
        except subprocess.CalledProcessError:
            screen = ""
        # The status line ("Model: …") only renders once the claude prompt is live.
        if "Model:" in screen or "auto mode" in screen:
            return True
        subprocess.run(["sleep", "0.5"], check=False)
        deadline -= 0.5
    return False


def _cmux_run_in_surface(cmux: str, surface: str, cmd: str) -> None:
    """Type `cmd` into a cmux surface, then `/rewind` if forking. Surfaces have no
    --command flag, so everything is sent as keystrokes."""
    subprocess.run([cmux, "send", "--surface", surface, "--", f"{cmd}\n"], check=True)
    if SEND_REWIND:
        if _cmux_wait_ready(cmux, surface):
            subprocess.run([cmux, "send", "--surface", surface, "--", "/rewind\n"],
                           check=False)
            note_rewind()
        else:
            _note_rewind_manual()


def launch_cmux(argv: list[str], cwd: Path) -> None:
    cmux = _cmux_bin()
    cmd = f"cd {shlex.quote(str(cwd))} && {shlex.join(argv)}"

    if CMUX_TARGET == "tab":
        # A tab is a surface in the caller's current workspace ($CMUX_WORKSPACE_ID).
        out = _cmux(cmux, "new-surface")
        surface = _parse_cmux_ref(out, "surface")
        if not surface:
            raise RuntimeError(f"could not parse new surface from: {out!r}")
        _cmux_run_in_surface(cmux, surface, cmd)
        return

    if CMUX_TARGET in _SPLIT_DIR:
        # Split the current pane; the new pane is a surface we send the command to.
        out = _cmux(cmux, "new-split", _SPLIT_DIR[CMUX_TARGET])
        surface = _parse_cmux_ref(out, "surface")
        if not surface:
            raise RuntimeError(f"could not parse split surface from: {out!r}")
        _cmux_run_in_surface(cmux, surface, cmd)
        return

    if CMUX_TARGET == "workspace":
        # A new workspace in the current window; --command runs it natively.
        # No interactive surface to inject into, so /rewind is a printed hint.
        _cmux(cmux, "new-workspace", "--cwd", str(cwd), "--command", cmd)
        _note_rewind_manual()
        return

    # window: new-window prints `OK <window-uuid>` (a bare UUID, not a ref) and has
    # no --command, so create a workspace via new-workspace (--command runs it), then
    # move it into the fresh window and focus it.
    win = _cmux_uuid(_cmux(cmux, "new-window"))
    if not win:
        raise RuntimeError("could not parse new window id from cmux")
    ws = _parse_cmux_ref(
        _cmux(cmux, "new-workspace", "--cwd", str(cwd), "--command", cmd), "workspace"
    )
    if not ws:
        raise RuntimeError("could not parse new workspace ref from cmux")
    _cmux(cmux, "move-workspace-to-window", "--workspace", ws, "--window", win)
    subprocess.run([cmux, "focus-window", "--window", win], check=True)
    _note_rewind_manual()


def _cmux_uuid(output: str) -> str | None:
    """Extract the UUID that `OK <uuid>` commands (e.g. new-window) print."""
    parts = output.split()
    return parts[1] if len(parts) >= 2 and parts[0] == "OK" else None


GhosttyTarget = Literal["new-window", "tab", "split-h", "split-v"]

# Where a ghostty session lands. Set from --ghostty-target before the surface runs.
GHOSTTY_TARGET: GhosttyTarget = "new-window"

# Ghostty default keybinds for opening a tab/split in the *focused* window.
_GHOSTTY_KEYSTROKE: dict[str, str] = {
    "tab": 't using command down',                 # super+t  → new tab
    "split-h": 'd using command down',             # super+d  → split right
    "split-v": 'd using {command down, shift down}',  # super+shift+d → split down
}


def _osa(*lines: str) -> None:
    subprocess.run(["osascript", "-e", "\n".join(lines)], check=True)


def launch_ghostty(argv: list[str], cwd: Path) -> None:
    cmd = f"cd {shlex.quote(str(cwd))} && {shlex.join(argv)}"

    if GHOSTTY_TARGET == "new-window":
        # A brand-new app window: the CLI can't launch the emulator directly, use `open -na`.
        wrapped = ["bash", "-lc", f"{cmd}"]
        subprocess.run(["open", "-na", "Ghostty.app", "--args", "-e", *wrapped], check=True)
        _note_rewind_manual()
        return

    # tab / split: drive the focused Ghostty window via its default keybinds, then
    # type the command. Assumes Ghostty is frontmost (true when /spawn runs in it).
    keystroke = _GHOSTTY_KEYSTROKE[GHOSTTY_TARGET]
    _osa(
        'tell application "Ghostty" to activate',
        'delay 0.2',
        f'tell application "System Events" to keystroke {keystroke}',
        'delay 0.5',
        f'tell application "System Events" to keystroke "{_osa_escape(cmd)}"',
        'tell application "System Events" to key code 36',  # Return
    )
    if SEND_REWIND:
        subprocess.run(["sleep", str(REWIND_BOOT_DELAY)], check=False)
        _osa(
            'tell application "System Events" to keystroke "/rewind"',
            'tell application "System Events" to key code 36',
        )
        note_rewind()


def _osa_escape(text: str) -> str:
    """Escape a string for embedding inside an AppleScript double-quoted literal."""
    return text.replace("\\", "\\\\").replace('"', '\\"')


def launch_terminal(argv: list[str], cwd: Path) -> None:
    cmd = f"cd {shlex.quote(str(cwd))} && {shlex.join(argv)}"
    script = f'tell application "Terminal" to do script "{_osa_escape(cmd)}"'
    subprocess.run(["osascript", "-e", script], check=True)
    _note_rewind_manual()


SURFACES: dict[str, LaunchFn] = {
    "headless": launch_headless,
    "tmux": launch_tmux,
    "cmux": launch_cmux,
    "ghostty": launch_ghostty,
    "terminal": launch_terminal,
}


@dataclass(frozen=True)
class SurfaceProbe:
    """What surface auto-detection found.

    `inside` lists surfaces we are demonstrably running *inside* (a strong env
    signal — $TMUX, $CMUX_*, $TERM_PROGRAM). `available` lists surfaces merely
    installed (PATH / app bundle) but with no proof we're in one. Detection is
    confident only when exactly one surface is in `inside`.
    """

    inside: tuple[Surface, ...]
    available: tuple[Surface, ...]

    @property
    def confident(self) -> Surface | None:
        return self.inside[0] if len(self.inside) == 1 else None


def _cmux_installed() -> bool:
    return bool(shutil.which("cmux")) or Path(
        "/Applications/cmux.app/Contents/Resources/bin/cmux"
    ).exists()


def _ghostty_installed() -> bool:
    return bool(shutil.which("ghostty")) or Path("/Applications/Ghostty.app").exists()


def probe_surface() -> SurfaceProbe:
    """Detect which surfaces we're inside vs. merely have available.

    Strong "inside" signals (proof we're running there):
      tmux    — $TMUX is set
      cmux    — $CMUX_WORKSPACE_ID / $CMUX_SURFACE_ID is set
      ghostty — $TERM_PROGRAM == ghostty, or $GHOSTTY_RESOURCES_DIR is set

    tmux-inside-cmux is real (cmux can host a tmux pane), so both can light up;
    that ambiguity is surfaced rather than silently resolved.
    """
    env = os.environ
    inside: list[Surface] = []
    if env.get("TMUX"):
        inside.append("tmux")
    if env.get("CMUX_WORKSPACE_ID") or env.get("CMUX_SURFACE_ID"):
        inside.append("cmux")
    if env.get("TERM_PROGRAM") == "ghostty" or env.get("GHOSTTY_RESOURCES_DIR"):
        inside.append("ghostty")

    available: list[Surface] = []
    if _cmux_installed():
        available.append("cmux")
    if _ghostty_installed():
        available.append("ghostty")
    if shutil.which("tmux"):
        available.append("tmux")

    return SurfaceProbe(tuple(inside), tuple(available))


class AmbiguousSurface(RuntimeError):
    """Auto-detection couldn't pick a single surface; caller must confirm."""

    def __init__(self, probe: SurfaceProbe) -> None:
        self.probe = probe
        super().__init__("ambiguous surface")


def resolve_surface(requested: str, mode: Mode) -> Surface:
    if mode == "headless":
        return "headless"
    if requested != "auto":
        return requested  # type: ignore[return-value]

    probe = probe_surface()
    if probe.confident:
        return probe.confident
    # No single strong signal: don't guess between candidates — make the caller
    # (the agent) confirm with the user. Only a plain terminal with nothing else
    # installed is unambiguous enough to pick silently.
    if not probe.inside and not probe.available:
        return "terminal"
    raise AmbiguousSurface(probe)


def main() -> int:
    parser = argparse.ArgumentParser(description="Spawn another Claude Code session.")
    parser.add_argument("task", nargs="?", default="", help="prompt for the new session")
    parser.add_argument("--surface", default="auto",
                        choices=["auto", "tmux", "cmux", "ghostty", "terminal", "headless"])
    parser.add_argument("--cmux-target", default="tab",
                        choices=["tab", "window", "workspace", "split-h", "split-v"],
                        help="for --surface cmux: new tab, window, workspace, or "
                             "horizontal/vertical split")
    parser.add_argument("--tmux-target", default="window",
                        choices=["window", "split-h", "split-v", "session"],
                        help="for --surface tmux: new window (tab), horizontal/vertical "
                             "split, or detached session")
    parser.add_argument("--ghostty-target", default="new-window",
                        choices=["new-window", "tab", "split-h", "split-v"],
                        help="for --surface ghostty: new app window, or a tab/"
                             "horizontal/vertical split in the focused window")
    parser.add_argument("--mode", default="interactive",
                        choices=["interactive", "headless"])
    parser.add_argument("--context", default="fresh",
                        choices=["fresh", "summary", "fork"])
    parser.add_argument("--session-id", default=None,
                        help="parent session id for summary/fork. Pass ${CLAUDE_SESSION_ID} "
                             "from the /spawn command; the cwd-based fallback is unreliable "
                             "when multiple sessions share a project dir.")
    parser.add_argument("--model", default=None)
    parser.add_argument("--cwd", default=None, help="working directory (defaults to current)")
    parser.add_argument("--dry-run", action="store_true", help="print the claude command, don't launch")
    parser.add_argument("--detect-surface", action="store_true",
                        help="print surface auto-detection as JSON and exit (no launch). "
                             "Use this before spawning to decide whether to confirm with the user.")
    parser.add_argument("extra", nargs="*", help="extra args passed through to claude")
    args = parser.parse_args()

    if args.detect_surface:
        probe = probe_surface()
        print(json.dumps({
            "confident": probe.confident,
            "inside": list(probe.inside),
            "available": list(probe.available),
        }))
        return 0

    if not shutil.which("claude"):
        print("error: `claude` CLI not found on PATH", file=sys.stderr)
        return 1

    cwd = Path(args.cwd).resolve() if args.cwd else Path.cwd()
    mode: Mode = args.mode
    context: Context = args.context

    global CMUX_TARGET, TMUX_TARGET, GHOSTTY_TARGET, SEND_REWIND
    CMUX_TARGET = args.cmux_target
    TMUX_TARGET = args.tmux_target
    GHOSTTY_TARGET = args.ghostty_target

    parent_id = args.session_id
    if not parent_id and context in ("summary", "fork"):
        parent_id = latest_session_id(cwd)
        if parent_id:
            print(f"warning: no --session-id given; guessed parent {parent_id} by recency "
                  f"in {cwd}. Pass --session-id ${{CLAUDE_SESSION_ID}} to be sure.",
                  file=sys.stderr)

    if context == "fork":
        if not parent_id:
            print("error: fork needs a parent session; none found in", transcript_dir(cwd),
                  file=sys.stderr)
            return 1
        if mode == "headless":
            print("error: fork mode is interactive (it sends /rewind); use --mode interactive",
                  file=sys.stderr)
            return 1
        SEND_REWIND = True

    try:
        argv = claude_argv(
            mode=mode,
            context=context,
            task=args.task,
            cwd=cwd,
            parent_id=parent_id,
            model=args.model,
            extra=args.extra,
        )
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    try:
        surface = resolve_surface(args.surface, mode)
    except AmbiguousSurface as exc:
        p = exc.probe
        print("NEEDS_CONFIRMATION: surface auto-detection is ambiguous; pass --surface "
              "explicitly.", file=sys.stderr)
        print(f"  inside:    {', '.join(p.inside) or '(none)'}", file=sys.stderr)
        print(f"  available: {', '.join(p.available) or '(none)'}", file=sys.stderr)
        print(json.dumps({"confident": None, "inside": list(p.inside),
                          "available": list(p.available)}), file=sys.stderr)
        return 2

    if args.dry_run:
        if surface == "cmux":
            suffix = f"/{CMUX_TARGET}"
        elif surface == "tmux":
            suffix = f"/{TMUX_TARGET}"
        elif surface == "ghostty":
            suffix = f"/{GHOSTTY_TARGET}"
        else:
            suffix = ""
        print(f"surface={surface}{suffix} mode={mode} context={context}")
        print(f"parent={parent_id} send_rewind={SEND_REWIND}")
        if context == "fork" and args.task:
            print(f"task (run after /rewind): {args.task}")
        print("command:", shlex.join(argv))
        return 0

    try:
        result = SURFACES[surface](argv, cwd)
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"error launching via {surface}: {exc}", file=sys.stderr)
        return 1

    if surface != "headless":
        print(f"spawned claude via {surface} (context={context}, mode={mode})")
        if context == "fork" and args.task:
            print(f"  after picking a branch point, run your task: {args.task}")
    return result.returncode if result else 0


if __name__ == "__main__":
    raise SystemExit(main())

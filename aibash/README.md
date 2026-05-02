# aibash

Turn an English description into a bash command, using the Claude Code CLI as the LLM.

The script lists files in the current directory (with sizes and creation/modification times) and passes that listing as context, so requests like "copy the most recently created CSV" or "delete the largest file" can be resolved to concrete filenames without you having to type them.

## Requirements

- `claude` CLI installed and authenticated (this is what powers the translation — no API key needed beyond your Claude Code login).
- `uv` for running the script with PEP 723 inline metadata.
- Optional: `fzf` for `--pick`, `pbcopy` (macOS) / `xclip` / `wl-copy` for `--copy`.

## Usage

```bash
./aibash.py "copy the most recently created csv to backup.csv"
# → cp newest.csv backup.csv
```

### Flags

| Flag | What it does |
| --- | --- |
| `--pick` | Open `fzf` to pre-select a file from the current directory. The picked file is passed to the LLM as the authoritative source. |
| `-c`, `--copy` | Copy the generated command to the system clipboard (`pbcopy` / `xclip` / `wl-copy`). |
| `-r`, `--run` | Execute the generated command after a `[y/N]` confirmation. |
| `-y`, `--yes` | Execute the command immediately without confirmation. Implies `--run`. |
| `-v`, `--verbose` | Print diagnostic info — the picked file, clipboard tool used, and command being run. Off by default. |
| `--dir <path>` | List files from a directory other than `cwd`. |
| `--model <id>` | Override the Claude model. Defaults to `sonnet` (latest sonnet). |

### Examples

```bash
# Print the command only.
./aibash.py "make a tarball of all csv files called data.tar.gz"

# Pick a file with fzf, then describe what to do with it.
./aibash.py --pick "rename this file to backup.txt"

# Generate, copy to clipboard, and auto-run.
./aibash.py -c -y "delete every .log file older than 7 days"
```

## Output

- **Without `--run`/`--yes`:** the generated command is printed to **stdout** and nothing else (so you can pipe it to `bash` if you want).
- **With `--run`/`--yes`:** the command is executed via `os.execvp` and the command's own output is what you see — `aibash` adds no chatter of its own.
- `--verbose` adds diagnostic lines to **stderr** (picked file, clipboard tool, command being run before exec).
- Real errors (clipboard tool missing, ambiguous request, etc.) always go to stderr regardless of verbosity.

## How it works

`aibash` shells out to `claude -p` with:

- A small system prompt that constrains the model to output a JSON object with `command` and `notes` fields.
- A `--json-schema` for structured output.
- The current directory's file listing (name, size, creation time, modification time).
- All built-in tools (`Bash`, `Read`, etc.) disabled, so the model answers from the provided listing without trying to verify with shell calls.
- `--setting-sources ""` so user-level hooks don't inject content into the response.

#!/usr/bin/env bash
#
# Set up a git worktree for Beaver development.
#
# Usage:
#   scripts/worktree/setup-worktree.sh --lite [path]     # fixtures + .env/docs + npm install (no Zotero)
#   scripts/worktree/setup-worktree.sh [--start] <branch>  # full: lite + isolated Zotero profile/ports
#
# --lite (seconds, no Zotero):
#   Bootstraps an existing worktree (default: $PWD) for unit tests / lint /
#   typecheck / build:dev. Symlinks gitignored fixtures from the main worktree,
#   recreates extract-public source.pdf links, copies .env and symlinks
#   CLAUDE.local.md / AGENTS.md if missing, and runs npm install when needed.
#
# Full mode (minutes):
#   1. Creates ../beaver-zotero-<branchname> via `git worktree add`
#        - Existing branch: checked out as-is.
#        - New branch:      branched from the current HEAD.
#   2. Runs the lite bootstrap on that worktree.
#   3. APFS-clones the main dev profile + data dir to per-worktree paths.
#   4. Patches the cloned profile's prefs.js: unique HTTP / RDP ports +
#      dataDir override.
#   5. Writes the worktree's .env / .worktree-meta.json / .mcp.json.
#
# Defaults (override via env, full mode):
#   SRC_PROFILE   ~/Library/Application Support/Zotero/Profiles/i1aek1w8.beaver-dev
#   SRC_DATADIR   ~/Zotero beaver-dev
#   ZOTERO_BIN    /Applications/Zotero.app/Contents/MacOS/zotero
#   WORKTREE_DIR  <repo-parent>/beaver-zotero-<branchname>
#                 Override when an existing worktree doesn't fit the naming
#                 pattern (e.g. WORKTREE_DIR=/path/to/beaver-v0.19.1).
#                 If the path already exists, the `git worktree add` step is
#                 skipped and only the profile/data/env steps run.
#
# Port allocation:
#   Main dev   = HTTP 23124 / RDP 6100
#   Test inst. = HTTP 23125 / RDP 6101 (start-test-zotero.sh)
#   This script picks the next free pair starting at HTTP 23126 / RDP 6102,
#   skipping any already in use across existing profile prefs.js files.
#
# Cloning a LIVE data dir:
#   Zotero 10 runs its databases in WAL mode, so committed transactions can live
#   in the -wal file rather than the main .sqlite file, and a file-by-file copy
#   of a running instance is not a guaranteed-consistent snapshot. After
#   cloning, this script checkpoints every copied database (see
#   scripts/worktree/lib/zotero-clone.sh): the WAL is merged in and truncated, so the
#   clone starts as if the source had been quit cleanly instead of stalling
#   behind Zotero's "Checking database integrity…" startup check. A copy that
#   turns out to be inconsistent fails here rather than mid-launch.
#   Quitting the source Zotero first is still the cleanest option -- it
#   guarantees the clone carries the source's latest writes.
#
# Prerequisite (one-time, in the main repo):
#   Add to zotero-plugin.config.ts so concurrent Zotero processes don't
#   hand off to each other:
#     server: { startArgs: ["-no-remote"] }
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/zotero-clone.sh
source "$SCRIPT_DIR/lib/zotero-clone.sh"

# Parse flags + positionals.
#   --lite    fixtures/config/npm only (no Zotero profile). Optional [path].
#   --start   full mode only: launch `npm start` in the background when done.
LITE=0
START=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --lite)  LITE=1 ;;
    --start) START=1 ;;
    -h|--help|help)
      sed -n '3,55p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)      echo "Unknown flag: $arg" >&2; exit 2 ;;
    *)       POSITIONAL+=("$arg") ;;
  esac
done

if [[ "$LITE" == "1" && "$START" == "1" ]]; then
  echo "error: --lite and --start cannot be combined" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Lite bootstrap (also used as step 1b of full setup).
# ---------------------------------------------------------------------------
bootstrap_lite_worktree() {
  local WT="$1"
  WT="$(cd "$WT" && pwd)"

  [[ -d "$WT/.git" || -f "$WT/.git" ]] || {
    echo "Not a git worktree: $WT" >&2
    exit 1
  }

  local MAIN
  MAIN="$(git -C "$WT" worktree list --porcelain | awk '/^worktree / { print substr($0, 10); exit }')"
  [[ -d "$MAIN" ]] || { echo "Cannot locate main worktree" >&2; exit 1; }

  if [[ "$WT" == "$MAIN" ]]; then
    echo "Refusing to bootstrap the main worktree itself: $WT" >&2
    exit 1
  fi

  echo "==> Lite bootstrap: $WT"
  echo "    Main worktree: $MAIN"

  link_fixture_dir() {
    local rel="$1"
    local src="$MAIN/$rel"
    local dst="$WT/$rel"

    if [[ ! -d "$src" ]]; then
      echo "    (skip) main has no $rel"
      return
    fi
    if [[ -L "$dst" ]]; then
      echo "    (ok)   $rel already a symlink"
      return
    fi
    if [[ -e "$dst" ]]; then
      echo "    (skip) $rel exists and is not a symlink — leaving in place"
      return
    fi
    mkdir -p "$(dirname "$dst")"
    ln -s "$src" "$dst"
    echo "    (link) $rel -> $src"
  }

  echo "==> Symlinking bulk fixture dirs"
  link_fixture_dir "tests/fixtures/pdfs/sentences"

  # Recreate per-fixture source.pdf symlinks under extract-public/
  # (each is `source.pdf -> ../_shared/<sha>.pdf` — _shared/ is tracked).
  local EP_REL="tests/fixtures/pdfs/extract-public"
  if [[ -d "$MAIN/$EP_REL" && -d "$WT/$EP_REL" ]]; then
    echo "==> Recreating per-fixture source.pdf symlinks under $EP_REL"
    local count=0 src_link rel dst target
    while IFS= read -r src_link; do
      rel="${src_link#"$MAIN/"}"
      dst="$WT/$rel"
      target="$(readlink "$src_link")"
      [[ -L "$dst" ]] && continue
      [[ -e "$dst" ]] && continue
      mkdir -p "$(dirname "$dst")"
      ln -s "$target" "$dst"
      count=$((count + 1))
    done < <(find "$MAIN/$EP_REL" -maxdepth 2 -name source.pdf -type l 2>/dev/null)
    echo "    created $count symlink(s)"
  fi

  copy_if_missing() {
    local rel="$1"
    local src="$MAIN/$rel"
    local dst="$WT/$rel"

    if [[ ! -f "$src" ]]; then
      echo "    (skip) main has no $rel"
      return
    fi
    if [[ -e "$dst" ]]; then
      echo "    (ok)   $rel already present"
      return
    fi
    cp "$src" "$dst"
    echo "    (copy) $rel"
  }

  install_post_checkout_hook() {
    local src="$MAIN/scripts/worktree/hooks/post-checkout"
    local hooks_dir dst
    hooks_dir="$(git -C "$MAIN" rev-parse --path-format=absolute --git-common-dir)/hooks"
    dst="$hooks_dir/post-checkout"

    [[ -f "$src" ]] || return 0
    if [[ -e "$dst" ]] && ! cmp -s "$src" "$dst"; then
      echo "    (skip) post-checkout hook exists and differs; not overwriting"
      return 0
    fi
    mkdir -p "$hooks_dir"
    cp "$src" "$dst"
    chmod +x "$dst"
    echo "    (hook) post-checkout installed"
  }

  # Agent instruction files are symlinked, not copied: a copy silently drifts
  # from the main checkout, and every worktree should read the same one.
  link_if_missing() {
    local rel="$1"
    local src="$MAIN/$rel"
    local dst="$WT/$rel"

    if [[ ! -f "$src" ]]; then
      echo "    (skip) main has no $rel"
      return
    fi
    if [[ -L "$dst" ]]; then
      echo "    (ok)   $rel already linked"
      return
    fi
    if [[ -e "$dst" ]]; then
      echo "    (ok)   $rel present as a real file (not replacing; it will not track main)"
      return
    fi
    ln -s "$src" "$dst"
    echo "    (link) $rel -> $src"
  }

  # .env is copied, not linked: full setup rewrites it with this worktree's
  # profile path and ports.
  echo "==> Linking gitignored config files"
  copy_if_missing ".env"
  link_if_missing "CLAUDE.local.md"
  link_if_missing "AGENTS.md"

  # Install the post-checkout hook so worktrees created by other tooling (which
  # never runs this script) get the same links. The hook dir is shared by every
  # worktree, so installing it once covers all of them.
  install_post_checkout_hook

  # npm install — require a real install, not just a stray cache dir.
  if [[ -d "$WT/node_modules/.bin" || -f "$WT/node_modules/.package-lock.json" ]]; then
    echo "==> node_modules already populated, skipping npm install"
  else
    if [[ -d "$WT/node_modules" ]]; then
      echo "==> node_modules exists but looks empty (only cache dirs); running npm install"
    else
      echo "==> Running npm install (this can take a few minutes)"
    fi
    (cd "$WT" && npm install)
  fi
}

# --lite: bootstrap only, then exit.
if [[ "$LITE" == "1" ]]; then
  if [[ ${#POSITIONAL[@]} -gt 1 ]]; then
    echo "Usage: $0 --lite [worktree-path]" >&2
    exit 2
  fi
  LITE_WT="${POSITIONAL[0]:-$(pwd)}"
  bootstrap_lite_worktree "$LITE_WT"
  cat <<EOF

==> Done (lite).

  Worktree : $(cd "$LITE_WT" && pwd)

You can now run:
  npm test
  npm run lint
  npx tsc --noEmit
  npm run build:dev

The copied .env still points at the MAIN Zotero profile. For an isolated
Zotero (live tests / interactive use), run full setup:

  WORKTREE_DIR="$(cd "$LITE_WT" && pwd)" $0 <branchname>
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# Full setup (lite + isolated Zotero profile).
# ---------------------------------------------------------------------------
if [[ ${#POSITIONAL[@]} -ne 1 ]]; then
  echo "Usage: $0 [--start] <branchname>" >&2
  echo "       $0 --lite [worktree-path]" >&2
  exit 2
fi

BRANCH="${POSITIONAL[0]}"
# Sanitize for filesystem use (e.g. feat/foo -> feat-foo)
SAFE="${BRANCH//\//-}"

SRC_PROFILE="${SRC_PROFILE:-$HOME/Library/Application Support/Zotero/Profiles/i1aek1w8.beaver-dev}"
SRC_DATADIR="${SRC_DATADIR:-$HOME/Zotero beaver-dev}"
ZOTERO_BIN="${ZOTERO_BIN:-/Applications/Zotero.app/Contents/MacOS/zotero}"

[[ -d "$SRC_PROFILE" ]] || { echo "SRC_PROFILE not found: $SRC_PROFILE" >&2; exit 1; }
[[ -d "$SRC_DATADIR" ]] || { echo "SRC_DATADIR not found: $SRC_DATADIR" >&2; exit 1; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
PARENT_DIR="$(dirname "$REPO_ROOT")"
DEST_PROFILE="$HOME/Library/Application Support/Zotero/Profiles/beaver-dev-$SAFE"
DEST_DATADIR="$HOME/Zotero beaver-dev-$SAFE"

# If the branch is already checked out in another worktree, adopt that path
# instead of trying to add a second checkout (git would refuse).
EXISTING_WT=""
if git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
  EXISTING_WT="$(git worktree list --porcelain | awk -v b="refs/heads/$BRANCH" '
    /^worktree / { wt = substr($0, 10) }
    /^branch /   { if ($2 == b) { print wt; exit } }
  ')"
fi

# Pick worktree dir: explicit override > existing checkout > naming pattern
if [[ -n "${WORKTREE_DIR:-}" ]]; then
  : # honor user's explicit override
elif [[ -n "$EXISTING_WT" ]]; then
  WORKTREE_DIR="$EXISTING_WT"
  echo "==> Branch '$BRANCH' is already checked out at $EXISTING_WT (adopting that path)"
else
  WORKTREE_DIR="$PARENT_DIR/beaver-zotero-$SAFE"
fi

# 1. Create the worktree (or note it already exists)
if [[ -d "$WORKTREE_DIR" ]]; then
  echo "==> Worktree already exists: $WORKTREE_DIR (skipping git worktree add)"
else
  if git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
    echo "==> Branch '$BRANCH' exists; adding worktree at $WORKTREE_DIR"
    git worktree add "$WORKTREE_DIR" "$BRANCH"
  else
    CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    echo "==> Branch '$BRANCH' does not exist; creating from $CURRENT_BRANCH"
    # `git worktree add -b NEW PATH` branches from HEAD by default,
    # which is the currently-checked-out commit in this worktree.
    git worktree add "$WORKTREE_DIR" -b "$BRANCH"
  fi
fi

# 1b. Lite bootstrap: fixture symlinks, CLAUDE.local.md / AGENTS.md, npm install.
#     Full setup = lite + isolated Zotero. The worktree .env lite copies from
#     main (pointing at the main profile) is overwritten below.
bootstrap_lite_worktree "$WORKTREE_DIR"

# 2. Pick HTTP / RDP ports by scanning the OTHER profiles' prefs.js.
#
#    The scan must skip this worktree's own profile. Counting it as "in use"
#    would shift both ports by one on every re-run, orphaning the ports already
#    recorded in .env / .worktree-meta.json / .mcp.json and any instance running
#    on them -- so a re-run has to keep the ports the worktree already has.
collect_ports() {
  local key="$1" f
  for f in "$HOME/Library/Application Support/Zotero/Profiles/"*/prefs.js \
           /tmp/beaver-test-zotero/profile/prefs.js; do
    [[ -f "$f" ]] || continue
    [[ "$f" == "$DEST_PROFILE/prefs.js" ]] && continue
    grep -h "user_pref(\"$key\"" "$f" 2>/dev/null | grep -oE '[0-9]+' || true
  done
}

# This profile's current value for a port pref, if it has one. On a first run
# that's whatever the SOURCE profile used (the clone inherits it), which the
# caller rejects because the source still claims it.
current_port() {
  local key="$1"
  [[ -f "$DEST_PROFILE/prefs.js" ]] || return 0
  grep -m1 "user_pref(\"$key\"" "$DEST_PROFILE/prefs.js" 2>/dev/null \
    | grep -oE '[0-9]+' | head -1 || true
}

# Is some process listening on this port right now?
port_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# Keep this profile's current port if no other profile claims it; otherwise take
# the first port at or above the base that is neither claimed in another
# profile's prefs nor currently listening.
#
# The live check matters: Zotero does NOT fall back to another port. If its
# configured httpServer.port is taken it logs an error and runs with no HTTP
# server at all, so every /beaver/test/* probe and live test against this
# instance would fail. A port kept from a previous run is exempt -- this
# worktree's own Zotero may be the thing listening on it.
pick_port() {
  local base="$1" used="$2" current="$3" p
  if [[ -n "$current" ]] && ! echo "$used" | grep -qx "$current"; then
    echo "$current"
    return
  fi
  p="$base"
  while echo "$used" | grep -qx "$p" || port_listening "$p"; do p=$((p + 1)); done
  echo "$p"
}

HTTP_KEY='extensions.zotero.httpServer.port'
RDP_KEY='extensions.zotero.extensions.mcp-rdp.port'
HTTP_PORT="$(pick_port 23126 "$(collect_ports "$HTTP_KEY")" "$(current_port "$HTTP_KEY")")"
RDP_PORT="$(pick_port 6102  "$(collect_ports "$RDP_KEY")"  "$(current_port "$RDP_KEY")")"

# 3. Clone profile + data (APFS clone, near-instant)
#    Warn first if the source is live -- see the "Cloning a LIVE data dir" note
#    at the top. Only worth checking when something is actually about to be
#    copied.
source_zotero_running() {
  if command -v lsof >/dev/null 2>&1 \
     && lsof -- "$SRC_DATADIR/zotero.sqlite" >/dev/null 2>&1; then
    return 0
  fi
  # Fallback: Zotero removes the profile's `lock` symlink on a clean exit
  [[ -L "$SRC_PROFILE/lock" ]]
}

if [[ ! -d "$DEST_PROFILE" || ! -d "$DEST_DATADIR" ]] && source_zotero_running; then
  cat >&2 <<'WARN'
!!  The source Zotero appears to be RUNNING.
!!  Its databases are in WAL mode, so this copy is not a guaranteed-consistent
!!  snapshot. The checkpoint step below verifies the copy and reports anything
!!  wrong with it, but quitting the source Zotero first is the only way to
!!  guarantee the clone carries its latest writes.
WARN
fi

CLONED_PROFILE=0
if [[ -d "$DEST_PROFILE" ]]; then
  echo "==> Profile already exists, skipping clone: $DEST_PROFILE"
else
  echo "==> Cloning profile -> $DEST_PROFILE"
  cp -cR "$SRC_PROFILE" "$DEST_PROFILE"
  CLONED_PROFILE=1
fi

CLONED_DATADIR=0
if [[ -d "$DEST_DATADIR" ]]; then
  echo "==> Data dir already exists, skipping clone: $DEST_DATADIR"
else
  echo "==> Cloning data dir -> $DEST_DATADIR"
  cp -cR "$SRC_DATADIR" "$DEST_DATADIR"
  CLONED_DATADIR=1
fi

# 4. Clean up the copy: drop stale locks / recovery markers, then checkpoint the
#    cloned databases so the new instance starts as if the source had been quit
#    cleanly. Both steps apply ONLY to a destination this run actually cloned.
#    A profile / data dir kept from an earlier run may belong to a Zotero that is
#    running right now: its `.parentlock` is the live profile lock (deleting it
#    would let a second instance open the same database), its `*.is.corrupt`
#    markers are that instance's own recovery state, and Zotero 10 holds an
#    exclusive SQLite lock while live. Locks left behind by a crashed instance
#    need no help from us -- Zotero drops a lock whose owner is gone.
#    (`if`, not `&&`: under `set -e` a false `[[ ]] && …` list aborts the script.)
STRIP_DIRS=()
if [[ "$CLONED_PROFILE" == "1" ]]; then STRIP_DIRS+=("$DEST_PROFILE"); fi
if [[ "$CLONED_DATADIR" == "1" ]]; then STRIP_DIRS+=("$DEST_DATADIR"); fi
if [[ ${#STRIP_DIRS[@]} -gt 0 ]]; then
  zc_strip_clone_artifacts "${STRIP_DIRS[@]}"
else
  echo "==> Reusing the existing profile + data dir untouched"
  echo "    (stuck on \"Checking database integrity…\"? that repair is fix-db's job:"
  echo "     $SCRIPT_DIR/worktree-zotero.sh fix-db \"$WORKTREE_DIR\")"
fi

if [[ "$CLONED_DATADIR" == "1" ]]; then
  echo "==> Checkpointing cloned databases"
  if ! zc_normalize_databases "$DEST_DATADIR"; then
    cat >&2 <<EOF

!!  The cloned zotero.sqlite failed its integrity check, so this clone is not
!!  usable. That normally means the source Zotero was mid-write while its data
!!  dir was copied. Quit the source Zotero, remove the clone, and re-run:
!!
!!    rm -rf "$DEST_PROFILE" "$DEST_DATADIR"
!!    $0 $BRANCH
EOF
    exit 1
  fi
fi

# 5. Patch prefs.js (ports + dataDir + update prefs off)
echo "==> Patching prefs.js (HTTP=$HTTP_PORT, RDP=$RDP_PORT, dataDir=$DEST_DATADIR)"
python3 - "$DEST_PROFILE/prefs.js" "$DEST_DATADIR" "$HTTP_PORT" "$RDP_PORT" <<'PY'
import json, pathlib, re, sys
prefs_path, data_dir, http_port, rdp_port = sys.argv[1:]
p = pathlib.Path(prefs_path)
text = p.read_text() if p.exists() else ""

def set_pref(key, literal):
    global text
    line = f'user_pref("{key}", {literal});'
    pat = re.compile(r'^user_pref\("' + re.escape(key) + r'",[^\n]*\);\s*$', re.M)
    if pat.search(text):
        text = pat.sub(line, text)
    else:
        if text and not text.endswith("\n"):
            text += "\n"
        text += line + "\n"

set_pref("extensions.zotero.dataDir",                    json.dumps(data_dir))
set_pref("extensions.zotero.useDataDir",                 "true")
set_pref("extensions.zotero.httpServer.port",            http_port)
# mcp-rdp's bootstrap reads its port via Zotero.Prefs.get("extensions.mcp-rdp.port")
# (no `global` flag), which prepends `extensions.zotero.` — so the live key is
# `extensions.zotero.extensions.mcp-rdp.port`.
set_pref("extensions.zotero.extensions.mcp-rdp.port",    rdp_port)
set_pref("extensions.zotero.extensions.mcp-rdp.enabled", "true")
# CRITICAL: the clone inherits the source profile's Zotero account login, and
# autoSync defaults to on. Without this, every worktree instance syncs the same
# account in parallel: items created while testing leak into the real library
# via zotero.org, and real library changes leak into the worktree. Keep sync
# hard-off in every clone.
set_pref("extensions.zotero.sync.autoSync",              "false")
set_pref("extensions.zotero.sync.reminder.setUp.enabled", "false")
set_pref("extensions.zotero.automaticScraperUpdates",    "false")
set_pref("app.update.enabled",                           "false")
set_pref("app.update.auto",                              "false")
p.write_text(text)
PY

# 5b. Fresh clones inherit extensions.json whose addon `path` values still
#     point at the *source* profile. Zotero then fails to activate Beaver (and
#     other XPIs) from the clone's own extensions/ dir. Purge the registry so
#     the next launch rediscovers addons from DEST_PROFILE/extensions/.
if [[ "$CLONED_PROFILE" == "1" ]]; then
  echo "==> Purging inherited addon registry (fix absolute paths from source profile)"
  rm -f "$DEST_PROFILE/extensions.json" \
        "$DEST_PROFILE/addonStartup.json.lz4" \
        "$DEST_PROFILE/compatibility.ini" \
        "$DEST_PROFILE/extension-preferences.json"
  rm -rf "$DEST_PROFILE/startupCache"
fi

# 6. Write the worktree's .env.
#    The lite bootstrap copied main's .env (pointing at the MAIN profile), so we
#    regenerate it here: carry over every non-managed key from the existing file
#    (e.g. BEAVER_EXTRACT_FIXTURES_DIR) and overwrite the worktree-specific ones.
#    ZOTERO_HTTP_PORT / ZOTERO_RDP_PORT are recorded for humans; tests read the
#    HTTP port from process.env (see tests/helpers/fixtures.ts), and the agent's
#    machine-readable source of truth is .worktree-meta.json (written below).
ENV_FILE="$WORKTREE_DIR/.env"
echo "==> Writing $ENV_FILE (worktree profile + ports)"
python3 - "$ENV_FILE" "$ZOTERO_BIN" "$DEST_PROFILE" "$HTTP_PORT" "$RDP_PORT" <<'PY'
import sys, pathlib
env_path, zbin, profile, http_port, rdp_port = sys.argv[1:]
p = pathlib.Path(env_path)
managed = {
    "ZOTERO_PLUGIN_ZOTERO_BIN_PATH": zbin,
    "ZOTERO_PLUGIN_PROFILE_PATH": profile,
    "ZOTERO_HTTP_PORT": http_port,
    "ZOTERO_RDP_PORT": rdp_port,
}
kept = []
if p.exists():
    for line in p.read_text().splitlines():
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        # Drop any prior managed line and the data-dir override (prefs.js owns
        # the data dir), plus a previously-written header so re-runs stay clean;
        # keep everything else (comments, custom keys) verbatim.
        if key in managed or key == "ZOTERO_PLUGIN_DATA_DIR":
            continue
        if line.startswith("# Auto-managed worktree values"):
            continue
        kept.append(line)
# Drop leading blank lines so the single separator below doesn't grow per run.
while kept and kept[0] == "":
    kept.pop(0)
out = ["# Auto-managed worktree values written by scripts/worktree/setup-worktree.sh"]
out.extend(f"{k} = {v}" for k, v in managed.items())
# Data dir is set via prefs.js, not here — keep the plugin var empty.
out.append("ZOTERO_PLUGIN_DATA_DIR =")
out.append("")
out.extend(kept)
p.write_text("\n".join(out).rstrip("\n") + "\n")
PY

# 7. Record machine-readable worktree metadata so an agent can discover its own
#    ports/paths without re-deriving them (read with `jq` or any JSON parser).
META_FILE="$WORKTREE_DIR/.worktree-meta.json"
echo "==> Writing $META_FILE"
python3 - "$META_FILE" "$BRANCH" "$WORKTREE_DIR" "$DEST_PROFILE" "$DEST_DATADIR" "$HTTP_PORT" "$RDP_PORT" <<'PY'
import json, sys
path, branch, wt, profile, datadir, http_port, rdp_port = sys.argv[1:]
data = {
    "branch": branch,
    "worktree": wt,
    "profile": profile,
    "dataDir": datadir,
    "httpPort": int(http_port),
    "rdpPort": int(rdp_port),
    "mcpServer": "zotero-worktree",
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

# 8. Write a per-worktree .mcp.json so a Claude Code session STARTED IN THIS DIR
#    auto-exposes `mcp__zotero-worktree__*` pinned to this worktree's instance.
#    The stable server name keeps tool names predictable across worktrees.
#    Note: this only takes effect for a fresh top-level session opened in this
#    directory (one-time project-MCP approval required); a subagent of another
#    session inherits that session's MCP connections, not this file.
MCP_FILE="$WORKTREE_DIR/.mcp.json"
echo "==> Writing $MCP_FILE (server: zotero-worktree, RDP $RDP_PORT)"
python3 - "$MCP_FILE" "$RDP_PORT" "$DEST_DATADIR" "$DEST_PROFILE" <<'PY'
import json, sys
path, rdp_port, datadir, profile = sys.argv[1:]
config = {
    "mcpServers": {
        "zotero-worktree": {
            "command": "npx",
            "args": ["@introfini/mcp-server-zotero-dev"],
            "env": {
                "ZOTERO_RDP_PORT": rdp_port,
                "ZOTERO_DATA_DIR": datadir,
                "ZOTERO_PROFILE_PATH": profile,
            },
        }
    }
}
with open(path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PY

# 9. Keep the generated local artifacts out of git via the shared common dir's
#    info/exclude (untracked, applies to every worktree — no tracked-file churn).
COMMON_GIT_DIR="$(git -C "$WORKTREE_DIR" rev-parse --path-format=absolute --git-common-dir)"
EXCLUDE_FILE="$COMMON_GIT_DIR/info/exclude"
if [[ -n "$COMMON_GIT_DIR" ]]; then
  mkdir -p "$COMMON_GIT_DIR/info"
  for pat in ".mcp.json" ".worktree-meta.json" ".worktree-start.log" ".worktree-zotero.log"; do
    grep -qxF "$pat" "$EXCLUDE_FILE" 2>/dev/null || echo "$pat" >>"$EXCLUDE_FILE"
  done
fi

# 10. Build the React bundle if this worktree doesn't have one yet.
#
#     `npm start` runs `zotero-plugin serve` and `webpack --watch` concurrently.
#     serve copies addon/ into .scaffold/build and installs the plugin within a
#     second; webpack's first build takes ~20s+. addon/content/reactBundle.js is
#     a gitignored build artifact, so a FRESH worktree doesn't have it at copy
#     time -- and serve does not re-copy it once webpack finally emits it. The
#     plugin then loads with no React bundle at all: no sidebar, no Jotai store,
#     and no /beaver/test/* endpoints (so worktree-ready.sh can never see a
#     ping). Building it here removes the race.
if [[ -f "$WORKTREE_DIR/addon/content/reactBundle.js" ]]; then
  echo "==> React bundle already present, skipping build"
else
  echo "==> Building the React bundle (first build in this worktree, ~30s)"
  (cd "$WORKTREE_DIR" && npm run build-react:dev)
fi

# 11. Optionally launch `npm start` (Zotero + webpack watch) in the background.
#
#     Never on a re-run whose Zotero is already up: the second launch would fight
#     the first over the profile and over .scaffold/build, and the profile lock
#     turns it into a "profile in use" dialog rather than a working instance.
if [[ "$START" == "1" ]] && zc_dir_in_use "$DEST_PROFILE"; then
  echo "==> Zotero is already running for this worktree -- not launching a second one."
  echo "    Pick up its changes with: scripts/worktree/worktree-zotero.sh reload \"$WORKTREE_DIR\""
  START=0
fi

if [[ "$START" == "1" ]]; then
  START_LOG="$WORKTREE_DIR/.worktree-start.log"
  echo "==> Launching 'npm start' in the background (logs: $START_LOG)"
  # The redirections on the SUBSHELL are load-bearing, not decoration. Without
  # them the long-lived `npm start` inherits this script's stdout/stderr, so any
  # caller reading our output through a pipe -- `$(setup-worktree.sh --start …)`,
  # which is exactly what worktree-ready.sh does -- blocks until Zotero is
  # killed, because the pipe stays open even after this script is done.
  (cd "$WORKTREE_DIR" && nohup npm start >"$START_LOG" 2>&1 </dev/null &) </dev/null >/dev/null 2>&1
fi

cat <<EOF

==> Done.

  Worktree   : $WORKTREE_DIR
  Profile    : $DEST_PROFILE
  Data dir   : $DEST_DATADIR
  HTTP port  : $HTTP_PORT
  RDP port   : $RDP_PORT
  MCP server : zotero-worktree (.mcp.json)

Probing the worktree's Zotero:
  - Over HTTP (works from ANY session, no MCP):
      curl -sS -X POST http://127.0.0.1:$HTTP_PORT/beaver/test/ping
      ZOTERO_HTTP_PORT=$HTTP_PORT npm run test:live
  - Over MCP (execute_js / DB / screenshots): open a NEW \`claude\` session in
      $WORKTREE_DIR
    so it loads .mcp.json -> mcp__zotero-worktree__* (approve the project MCP
    server once). A subagent of another session cannot reach this instance.

Next steps (reload-driven, recommended for agents):
  scripts/worktree/worktree-zotero.sh open "$WORKTREE_DIR"
  scripts/worktree/worktree-zotero.sh reload "$WORKTREE_DIR"   # after source edits

Optional hot-reload watcher (human UI iteration):
  scripts/worktree/worktree-zotero.sh watch "$WORKTREE_DIR"
  # or: cd "$WORKTREE_DIR" && npm start

If your main worktree's Zotero is already running, make sure
zotero-plugin.config.ts has  server: { startArgs: ["-no-remote"] }
so the new instance won't try to hand off to the existing one.
EOF

# Machine-readable trailer for wrapper scripts (scripts/worktree-ready.sh greps
# this to locate the metadata file without re-deriving the worktree path).
echo "WORKTREE_META_PATH=$META_FILE"

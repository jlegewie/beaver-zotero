#!/usr/bin/env bash
#
# Human-facing helper for worktree Zotero instances.
#
# Worktrees are reload-driven by default (agent-friendly): edit → reload → probe.
# Optional `watch` starts npm start for human UI iteration with hot-reload.
#
# Usage (from any beaver checkout, or pass a worktree path):
#   scripts/worktree/worktree-zotero.sh                  # status for $PWD
#   scripts/worktree/worktree-zotero.sh status [path]
#   scripts/worktree/worktree-zotero.sh list             # all beaver-dev / worktree Zoteros
#   scripts/worktree/worktree-zotero.sh open [path]      # focus running Zotero, or launch it (no watcher)
#   scripts/worktree/worktree-zotero.sh reload [path]    # build:dev + install xpi + reload/restart
#   scripts/worktree/worktree-zotero.sh watch [path]     # optional: npm start hot-reload watcher
#   scripts/worktree/worktree-zotero.sh fix-db [path]    # quit that instance, checkpoint DBs, offer restart
#   scripts/worktree/worktree-zotero.sh stop [path]      # quit Zotero (+ watcher if any) for this worktree
#
# Updating the plugin after edits:
#   Default:  scripts/worktree/worktree-zotero.sh reload
#     Runs build:dev, installs beaver.xpi into the worktree profile, then reloads
#     via RDP (or restarts Zotero if RDP is down). Do this after a batch of edits.
#   Optional: scripts/worktree/worktree-zotero.sh watch
#     Starts npm start (serve + webpack). Saves hot-reload automatically — do NOT
#     run build:dev / reload while watch is up (clobbers bootstrap.js).
#
# Identifying windows stuck on "Checking database integrity…":
#   run `list` — each row shows PID, profile short name, ports, HTTP health, and
#   whether the data dir looks like an unclean/corrupt startup (non-empty WAL,
#   *.is.corrupt, *.check.tmp). Match the stuck window to a row via PID in
#   Activity Monitor, or by quitting one profile at a time with `stop`.
#
# Integrity fix:
#   Zotero 10 runs a full integrity check when zotero.sqlite-wal is non-empty
#   (unclean shutdown / clone of a live data dir). `fix-db` quits that instance,
#   then reuses scripts/worktree/lib/zotero-clone.sh to checkpoint / drop a mismatched WAL
#   so the next launch skips the stall.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/zotero-clone.sh
source "$SCRIPT_DIR/lib/zotero-clone.sh"

CMD="${1:-status}"
ARG_PATH="${2:-}"
ADDON_ID="beaver@jlegewie.com"
DEFAULT_ZOTERO_BIN="/Applications/Zotero.app/Contents/MacOS/zotero"

die() { echo "error: $*" >&2; exit 1; }

# Resolve a worktree directory (absolute).
resolve_wt() {
  local p="${1:-}"
  if [[ -n "$p" ]]; then
    [[ -d "$p" ]] || die "not a directory: $p"
    (cd "$p" && pwd)
    return
  fi
  pwd
}

is_beaver_checkout() {
  local d="$1"
  [[ -f "$d/package.json" && -f "$d/zotero-plugin.config.ts" ]]
}

# Read .worktree-meta.json into globals: WT_BRANCH WT_PROFILE WT_DATADIR WT_HTTP WT_RDP
# Returns 1 if missing.
load_meta() {
  local wt="$1" meta="$1/.worktree-meta.json"
  WT_BRANCH="" WT_PROFILE="" WT_DATADIR="" WT_HTTP="" WT_RDP=""
  [[ -f "$meta" ]] || return 1
  # shellcheck disable=SC2046
  eval "$(python3 - "$meta" <<'PY'
import json, shlex, sys
m = json.load(open(sys.argv[1]))
for k, env in [
    ("branch", "WT_BRANCH"),
    ("profile", "WT_PROFILE"),
    ("dataDir", "WT_DATADIR"),
    ("httpPort", "WT_HTTP"),
    ("rdpPort", "WT_RDP"),
]:
    v = m.get(k, "")
    print(f"{env}={shlex.quote(str(v))}")
PY
)"
  return 0
}

# Read dataDir / http / rdp from a profile's prefs.js into WT_* if unset.
fill_from_prefs() {
  local prefs="${1:-}/prefs.js"
  [[ -f "$prefs" ]] || return 0
  # shellcheck disable=SC2046
  eval "$(python3 - "$prefs" <<'PY'
import re, shlex, sys
text = open(sys.argv[1]).read()

def pref(key):
    m = re.search(r'user_pref\("' + re.escape(key) + r'",\s*([^)]+)\);', text)
    if not m:
        return ""
    raw = m.group(1).strip()
    if raw.startswith('"'):
        return raw[1:-1].encode("utf-8").decode("unicode_escape")
    return raw

data = {
    "WT_DATADIR": pref("extensions.zotero.dataDir"),
    "WT_HTTP": pref("extensions.zotero.httpServer.port"),
    "WT_RDP": pref("extensions.zotero.extensions.mcp-rdp.port"),
}
for k, v in data.items():
    if v:
        print(f"{k}={shlex.quote(v)}")
PY
)"
}

# Main-repo fallback: .env points at the primary beaver-dev profile.
load_main_env_profile() {
  local wt="$1" envf="$1/.env"
  WT_BRANCH="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  WT_PROFILE=""
  WT_DATADIR=""
  WT_HTTP=""
  WT_RDP=""
  [[ -f "$envf" ]] || return 1
  # shellcheck disable=SC2046
  eval "$(python3 - "$envf" <<'PY'
import re, shlex, sys
text = open(sys.argv[1]).read().splitlines()
vals = {}
for line in text:
    m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)$', line)
    if not m:
        continue
    vals[m.group(1)] = m.group(2).strip().strip('"').strip("'")
mapping = {
    "ZOTERO_PLUGIN_PROFILE_PATH": "WT_PROFILE",
    "ZOTERO_HTTP_PORT": "WT_HTTP",
    "ZOTERO_RDP_PORT": "WT_RDP",
}
for src, dst in mapping.items():
    if src in vals and vals[src]:
        print(f"{dst}={shlex.quote(vals[src])}")
PY
)"
  [[ -n "$WT_PROFILE" ]] || return 1
  # Prefer prefs.js for dataDir + ports (main .env often omits HTTP/RDP).
  local saved_http="$WT_HTTP" saved_rdp="$WT_RDP"
  fill_from_prefs "$WT_PROFILE"
  [[ -n "$saved_http" ]] && WT_HTTP="$saved_http"
  [[ -n "$saved_rdp" ]] && WT_RDP="$saved_rdp"
  return 0
}

profile_short() {
  basename "${1:-}"
}

# PIDs of main Zotero processes using this profile (exclude debugger toolbox / plugin-container).
zotero_pids_for_profile() {
  local profile="$1"
  [[ -n "$profile" ]] || return 0
  ps -axo pid=,command= | awk -v p="$profile" '
    $0 ~ /\/MacOS\/zotero / && $0 !~ /chrome_debugger_profile/ && $0 !~ /plugin-container/ {
      if (index($0, "-profile " p) || index($0, "-profile " p "/")) print $1
    }'
}

port_listening() {
  local port="$1"
  [[ -n "$port" ]] || return 1
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

http_health() {
  local port="$1"
  if [[ -z "$port" ]] || ! port_listening "$port"; then
    echo "down"
    return
  fi
  if curl -fsS -m 2 -X POST "http://127.0.0.1:$port/beaver/test/ping" \
       -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1; then
    echo "beaver-ok"
    return
  fi
  if curl -fsS -m 2 "http://127.0.0.1:$port/connector/ping" >/dev/null 2>&1; then
    echo "zotero-up"
    return
  fi
  echo "port-listen"
}

# Heuristic for integrity-check stalls.
# A live Zotero always has a non-empty WAL — that is normal. A non-empty WAL
# (or recovery markers) with Zotero quit is what triggers the next-launch stall.
# Usage: db_stall_hint <data-dir> [running|stopped]
db_stall_hint() {
  local datadir="$1" state="${2:-}"
  [[ -n "$datadir" && -d "$datadir" ]] || { echo "-"; return; }
  local hints=()
  local wal="$datadir/zotero.sqlite-wal"
  local sz=0
  if [[ -f "$wal" ]]; then
    sz="$(stat -f%z "$wal" 2>/dev/null || echo 0)"
  fi
  if compgen -G "$datadir"'/*.is.corrupt' >/dev/null 2>&1; then
    hints+=("is.corrupt")
  fi
  if compgen -G "$datadir"'/*.check.tmp*' >/dev/null 2>&1; then
    hints+=("check.tmp")
  fi
  if compgen -G "$datadir"'/*.repair.tmp*' >/dev/null 2>&1; then
    hints+=("repair.tmp")
  fi
  if [[ "$state" == "running" ]]; then
    if [[ ${#hints[@]} -gt 0 ]]; then
      local IFS=,
      echo "running+${hints[*]}"
    else
      echo "running"
    fi
    return
  fi
  if [[ "$sz" -gt 0 ]]; then
    hints+=("unclean-wal=${sz}b")
  fi
  if [[ ${#hints[@]} -eq 0 ]]; then
    echo "clean"
  else
    local IFS=,
    echo "${hints[*]}"
  fi
}

activate_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  osascript -e "tell application \"System Events\" to set frontmost of first process whose unix id is $pid to true" 2>/dev/null \
    || true
}

ask_yes() {
  local prompt="$1" ans
  if [[ ! -t 0 ]]; then
    return 1
  fi
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" || "$ans" == "yes" ]]
}

# PIDs of npm start / zotero-plugin serve / concurrently for this worktree.
serve_pids_for_wt() {
  local wt="$1"
  [[ -n "$wt" ]] || return 0
  ps -axo pid=,command= | grep -F "$wt" | grep -E 'npm start|zotero-plugin serve|concurrently' | grep -v grep | awk '{print $1}' || true
}

serve_running_for_wt() {
  local pids
  pids="$(serve_pids_for_wt "$1")"
  [[ -n "$pids" ]]
}

# Call one MCP tool against this worktree's RDP port. Retries a few times —
# back-to-back calls sometimes fail the pre-flight probe while the port is
# still listening.
rdp_exec() {
  # IMPORTANT: do not write ${2:-{}} — bash ends the expansion at the first `}`,
  # so a set $2 of "{}" becomes "{}}" and JSON.parse fails.
  local tool="$1"
  local args="${2-}"
  [[ -n "$args" ]] || args='{}'
  local exec_js="$SCRIPT_DIR/zotero-rdp-exec.mjs"
  [[ -f "$exec_js" ]] || die "missing $exec_js"
  [[ -n "$WT_RDP" ]] || die "no RDP port configured for this worktree"
  local attempt out rc
  for attempt in 1 2 3; do
    set +e
    out="$(node "$exec_js" "$WT_RDP" "$tool" "$args" 2>&1)"
    rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      printf '%s\n' "$out"
      return 0
    fi
    # Pre-flight "nothing listening" is fatal only if the port really is down.
    if [[ "$out" == *"Nothing is listening on RDP port"* ]] && ! port_listening "$WT_RDP"; then
      printf '%s\n' "$out" >&2
      return 1
    fi
    sleep 2
  done
  printf '%s\n' "$out" >&2
  return 1
}

# Install the packed XPI and force Zotero to rediscover addons from this
# profile's extensions/ dir. Cloned worktree profiles inherit extensions.json
# entries whose `path` still points at the *source* profile, so a bare cp of
# the XPI is not enough — Beaver stays inactive / invisible.
#
# Caller must ensure Zotero is quit before this runs (we delete extensions.json).
install_beaver_xpi() {
  local wt="$1" profile="$2"
  local xpi="$wt/.scaffold/build/beaver.xpi"
  [[ -f "$xpi" ]] || die "expected $xpi after build:dev"
  [[ -n "$profile" && -d "$profile" ]] || die "profile missing: $profile"
  if [[ -n "$(zotero_pids_for_profile "$profile")" ]]; then
    die "refusing to rewrite addon registry while Zotero is using $profile (stop it first)"
  fi
  mkdir -p "$profile/extensions"
  rm -f "$profile/extensions/${ADDON_ID}.xpi"
  rm -rf "$profile/extensions/${ADDON_ID}"
  cp "$xpi" "$profile/extensions/${ADDON_ID}.xpi"
  echo "Installed $(basename "$xpi") → $profile/extensions/${ADDON_ID}.xpi"
  echo "Purging inherited addon registry so Zotero rediscovers extensions/…"
  rm -f "$profile/extensions.json" \
        "$profile/addonStartup.json.lz4" \
        "$profile/compatibility.ini" \
        "$profile/extension-preferences.json"
  rm -rf "$profile/startupCache"
}

resolve_zotero_bin() {
  local wt="$1" envf="$1/.env" bin=""
  if [[ -f "$envf" ]]; then
    bin="$(python3 - "$envf" <<'PY'
import re, sys
text = open(sys.argv[1]).read().splitlines()
for line in text:
    m = re.match(r'\s*ZOTERO_PLUGIN_ZOTERO_BIN_PATH\s*=\s*(.*)$', line)
    if m:
        print(m.group(1).strip().strip('"').strip("'"))
        break
PY
)"
  fi
  if [[ -z "$bin" ]]; then
    bin="${ZOTERO_PLUGIN_ZOTERO_BIN_PATH:-$DEFAULT_ZOTERO_BIN}"
  fi
  [[ -x "$bin" ]] || die "Zotero binary not executable: $bin"
  printf '%s\n' "$bin"
}

# Normalize dirty DBs before a cold start (unclean WAL stalls the next launch).
maybe_normalize_before_start() {
  local hint
  hint="$(db_stall_hint "$WT_DATADIR" stopped)"
  if [[ "$hint" != "clean" && "$hint" != "-" ]]; then
    echo "Data dir looks dirty ($hint) — normalizing before start…"
    zc_strip_clone_artifacts "$WT_PROFILE" "$WT_DATADIR"
    zc_normalize_databases "$WT_DATADIR" || die "database normalize failed; see messages above"
  fi
}

# @beaver/agent-ui ships its stylesheets as source; the build copies them into
# addon/content/styles/, where they are gitignored generated files. `open` does
# not build, and `setup-worktree.sh` runs only build-react:dev, so a fresh
# worktree can otherwise launch with them missing — which registers nothing and
# renders the whole plugin unstyled behind a single logError.
ensure_agent_ui_css() {
  local wt="$1"
  [[ -f "$wt/package.json" ]] || return 0
  if ! ls "$wt"/addon/content/styles/agent-ui-*.css >/dev/null 2>&1; then
    echo "Shared agent-ui stylesheets are missing — generating them."
    ( cd "$wt" && npm run --silent copy:agent-ui-css ) \
      || echo "WARNING: copy:agent-ui-css failed; the plugin will render unstyled."
  fi
}

# Launch this worktree's Zotero directly (no npm start / hot-reload watcher).
start_zotero_direct() {
  local wt="$1"
  local bin log
  bin="$(resolve_zotero_bin "$wt")"
  log="$wt/.worktree-zotero.log"
  maybe_normalize_before_start
  echo "Launching Zotero (no watcher) with profile $(profile_short "$WT_PROFILE")"
  echo "  bin     : $bin"
  echo "  profile : $WT_PROFILE"
  echo "  dataDir : ${WT_DATADIR:-"(prefs)"}"
  echo "  log     : $log"
  if [[ -n "${WT_DATADIR:-}" ]]; then
    (nohup "$bin" -profile "$WT_PROFILE" -no-remote -datadir "$WT_DATADIR" \
       >"$log" 2>&1 </dev/null &) </dev/null >/dev/null 2>&1
  else
    (nohup "$bin" -profile "$WT_PROFILE" -no-remote \
       >"$log" 2>&1 </dev/null &) </dev/null >/dev/null 2>&1
  fi
  echo "Started in background."
  echo "After edits, push a build with:  $0 reload $wt"
  echo "Ping when up:"
  echo "  curl -sS -X POST http://127.0.0.1:$WT_HTTP/beaver/test/ping -H 'Content-Type: application/json' -d '{}'"
}

# Optional human path: npm start (serve + webpack watch + Zotero).
start_npm_start_bg() {
  local wt="$1"
  local log="$wt/.worktree-start.log"
  maybe_normalize_before_start
  echo "Launching npm start / hot-reload watcher (log: $log)"
  echo "While this is running: saves hot-reload — do NOT run build:dev or reload."
  (cd "$wt" && nohup npm start >"$log" 2>&1 </dev/null &) </dev/null >/dev/null 2>&1
  echo "Started in background. Tail: $log"
}

ensure_identity() {
  local wt="$1"
  is_beaver_checkout "$wt" || die "not a beaver checkout: $wt"
  if load_meta "$wt"; then
    return 0
  fi
  if load_main_env_profile "$wt"; then
    echo "(no .worktree-meta.json — using .env profile for this checkout)" >&2
    return 0
  fi
  return 1
}

cmd_list() {
  # Discover worktrees via git (any path), not hardcoded layout globs.
  local repo_root
  repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
  python3 - "$repo_root" <<'PY'
import json, re, subprocess, sys, urllib.request
from pathlib import Path

repo_root = Path(sys.argv[1])

def http_health(port: str) -> str:
    if not port:
        return "down"
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/connector/ping", timeout=1.5)
    except Exception:
        return "down"
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/beaver/test/ping",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=1.5)
        return "beaver-ok"
    except Exception:
        return "zotero-up"

def pref(text: str, key: str) -> str:
    m = re.search(r'user_pref\("' + re.escape(key) + r'",\s*([^)]+)\);', text)
    if not m:
        return ""
    raw = m.group(1).strip()
    if raw.startswith('"'):
        return raw[1:-1].encode("utf-8").decode("unicode_escape")
    return raw

def db_hint(datadir: str, running: bool) -> str:
    if not datadir or not Path(datadir).is_dir():
        return "-"
    p = Path(datadir)
    bad = []
    for pat in ("*.is.corrupt", "*.check.tmp*", "*.repair.tmp*"):
        if list(p.glob(pat)):
            bad.append(pat.replace("*", "").strip("."))
    if running:
        return "running+" + ",".join(bad) if bad else "running"
    wal = p / "zotero.sqlite-wal"
    if wal.exists() and wal.stat().st_size > 0:
        bad.append(f"unclean-wal={wal.stat().st_size}b")
    return ",".join(bad) if bad else "clean"

def git_worktree_paths(root: Path) -> list[Path]:
    try:
        out = subprocess.check_output(
            ["git", "-C", str(root), "worktree", "list", "--porcelain"],
            text=True,
        )
    except Exception:
        return [root] if root.is_dir() else []
    paths = []
    for line in out.splitlines():
        if line.startswith("worktree "):
            paths.append(Path(line[len("worktree "):]))
    return paths or ([root] if root.is_dir() else [])

def profile_from_env(wt: Path) -> str:
    envf = wt / ".env"
    if not envf.is_file():
        return ""
    for line in envf.read_text(errors="replace").splitlines():
        m = re.match(r'\s*ZOTERO_PLUGIN_PROFILE_PATH\s*=\s*(.*)$', line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return ""

# Map profile path -> worktree path from every git worktree of this repo.
meta_map: dict[str, str] = {}
main_profile = ""
for wt in git_worktree_paths(repo_root):
    meta = wt / ".worktree-meta.json"
    if meta.is_file():
        try:
            m = json.load(open(meta))
            profile = m.get("profile") or ""
            if profile:
                meta_map[profile] = m.get("worktree") or str(wt)
        except Exception:
            pass
    else:
        # Primary checkout usually has no meta file — use .env profile.
        env_profile = profile_from_env(wt)
        if env_profile and not main_profile:
            main_profile = env_profile
            meta_map[env_profile] = str(wt)

ps = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True)
print(f"{'PID':<7}  {'HTTP':<8}  {'HEALTH':<12}  {'DB-HINT':<18}  {'PROFILE':<42}  WORKTREE / notes")
print("-------  --------  ------------  ------------------  ------------------------------------------  ----------------")
for line in ps.splitlines():
    if "/MacOS/zotero " not in line or "-profile " not in line:
        continue
    if "chrome_debugger_profile" in line or "plugin-container" in line:
        continue
    pid = line.strip().split(None, 1)[0]
    m = re.search(r"-profile (.+)$", line)
    if not m:
        continue
    rest = m.group(1)
    # profile path ends before the next option ( -- or space-dash flag)
    pm = re.match(r"(.+?)(?:\s+--|\s+-[A-Za-z]).*$", rest)
    profile = (pm.group(1) if pm else rest).strip()
    short = Path(profile).name
    http = datadir = ""
    prefs = Path(profile) / "prefs.js"
    if prefs.is_file():
        text = prefs.read_text(errors="replace")
        http = pref(text, "extensions.zotero.httpServer.port")
        datadir = pref(text, "extensions.zotero.dataDir")
    health = http_health(http) if http else "down"
    hint = db_hint(datadir, running=True)
    wt = meta_map.get(profile)
    if not wt:
        if main_profile and profile == main_profile:
            wt = "(main checkout .env)"
        elif short.endswith(".beaver-dev") or short.startswith("beaver-dev-"):
            wt = "(beaver profile, no .worktree-meta.json)"
        else:
            wt = "?"
    print(f"{pid:<7}  {http or '-':<8}  {health:<12}  {hint:<18}  {short:<42}  {wt}")
PY
}

print_status() {
  local wt="$1"
  echo "Worktree : $wt"
  if ! is_beaver_checkout "$wt"; then
    die "not a beaver checkout"
  fi

  if ! ensure_identity "$wt"; then
    cat <<EOF
Status   : not set up (no .worktree-meta.json / usable .env profile)

To create an isolated Zotero for this worktree:
  WORKTREE_DIR=$wt \\
    $SCRIPT_DIR/setup-worktree.sh \$(git -C "$wt" rev-parse --abbrev-ref HEAD)

Or one-shot bring-up:
  WORKTREE_DIR=$wt \\
    $SCRIPT_DIR/worktree-ready.sh \$(git -C "$wt" rev-parse --abbrev-ref HEAD)
EOF
    return 1
  fi

  local pids health hint state serve_pids
  pids="$(zotero_pids_for_profile "$WT_PROFILE" | tr '\n' ' ' | sed 's/ *$//')"
  serve_pids="$(serve_pids_for_wt "$wt" | tr '\n' ' ' | sed 's/ *$//')"
  health="$(http_health "$WT_HTTP")"
  if [[ -n "$pids" ]]; then state=running; else state=stopped; fi
  hint="$(db_stall_hint "$WT_DATADIR" "$state")"

  echo "Branch   : $WT_BRANCH"
  echo "Profile  : $WT_PROFILE"
  echo "Data dir : $WT_DATADIR"
  echo "HTTP     : ${WT_HTTP:-?}   RDP: ${WT_RDP:-?}"
  echo "DB hint  : $hint"
  if [[ -n "$pids" ]]; then
    echo "Zotero   : RUNNING (pid $pids)  health=$health"
  else
    echo "Zotero   : not running  health=$health"
  fi
  if [[ -n "$serve_pids" ]]; then
    echo "Serve    : RUNNING (pid $serve_pids) — hot-reload on save; do not build:dev/reload"
  else
    echo "Serve    : off (reload-driven) — after edits: $0 reload $wt"
  fi

  # Only warn about stall markers when Zotero is quit (unclean WAL) or has
  # explicit recovery files. A live WAL while running is normal.
  if [[ "$hint" == *unclean-wal* || "$hint" == *is.corrupt* || "$hint" == *check.tmp* || "$hint" == *repair.tmp* ]]; then
    cat <<EOF

Data dir has integrity-stall markers ($hint).
If a window is stuck on "Checking database integrity…", run:
  $0 fix-db $wt
EOF
  fi
}

cmd_open() {
  local wt
  wt="$(resolve_wt "$ARG_PATH")"

  if ! ensure_identity "$wt"; then
    echo "No isolated Zotero is configured for:"
    echo "  $wt"
    cat <<EOF

Create one with:
  WORKTREE_DIR=$wt \\
    $SCRIPT_DIR/setup-worktree.sh \$(git -C "$wt" rev-parse --abbrev-ref HEAD)

Then:
  $0 open $wt
  $0 reload $wt   # after source edits

Or one-shot bring-up (still uses npm start today):
  WORKTREE_DIR=$wt \\
    $SCRIPT_DIR/worktree-ready.sh \$(git -C "$wt" rev-parse --abbrev-ref HEAD)
EOF
    return 1
  fi

  local pids pid
  pids="$(zotero_pids_for_profile "$WT_PROFILE")"
  if [[ -n "$pids" ]]; then
    pid="$(head -1 <<<"$pids")"
    echo "Already running for this worktree."
    print_status "$wt" || true
    echo
    echo "Bringing PID $pid to the front…"
    activate_pid "$pid"
    echo "HTTP $WT_HTTP  →  curl -sS http://127.0.0.1:$WT_HTTP/connector/ping"
    if [[ "$(http_health "$WT_HTTP")" != "beaver-ok" ]]; then
      echo "(Beaver /beaver/test/ping not answering — log into Beaver in that window if you need dev endpoints.)"
    fi
    if serve_running_for_wt "$wt"; then
      echo
      echo "Hot-reload watcher is also running. For agent-style reload-driven work:"
      echo "  $0 stop $wt && $0 open $wt"
    else
      echo
      echo "Reload-driven mode. After edits:  $0 reload $wt"
    fi
    local hint
    hint="$(db_stall_hint "$WT_DATADIR" running)"
    if [[ "$hint" == *is.corrupt* || "$hint" == *check.tmp* || "$hint" == *repair.tmp* ]]; then
      echo
      echo "DB hint is '$hint'. If this window is stuck on integrity check:"
      echo "  $0 fix-db $wt"
    fi
    return 0
  fi

  echo "Configured, but Zotero is not running for this worktree."
  print_status "$wt" || true
  echo
  ensure_agent_ui_css "$wt"
  # Start immediately (no prompt) — `open` means open. Agents need this non-interactive.
  start_zotero_direct "$wt"
}

# One-shot: push this worktree's current sources into its Zotero instance.
# Always: build → (stop if needed) → install XPI + purge addon registry → start.
# Packed-XPI installs can't rely on in-place RDP reload for cloned profiles —
# extensions.json still points at the source profile until purged.
cmd_reload() {
  local wt
  wt="$(resolve_wt "$ARG_PATH")"
  ensure_identity "$wt" || die "this worktree has no Zotero profile configured"

  local pids
  pids="$(zotero_pids_for_profile "$WT_PROFILE")"

  if serve_running_for_wt "$wt"; then
    echo "Hot-reload watcher (npm start) is running for this worktree."
    echo "Do NOT run build:dev / reload — it clobbers serve's bootstrap.js."
    echo
    if [[ -n "$pids" ]]; then
      if port_listening "$WT_RDP"; then
        echo "Triggering zotero_plugin_reload over RDP $WT_RDP…"
        rdp_exec zotero_plugin_reload '{}' || die "plugin reload failed"
        echo "Forced one reload. Ordinary saves already hot-reload."
      else
        echo "RDP $WT_RDP is not listening — save any file under src/addon/react to hot-reload,"
        echo "or: touch \"$wt/addon/bootstrap.js\""
      fi
      echo
      echo "To switch to reload-driven mode:  $0 stop $wt && $0 open $wt"
      return 0
    fi
    echo "Watcher is up but Zotero is not. Start Zotero with:  $0 open $wt"
    echo "Or stop the orphan watcher:  $0 stop $wt"
    return 1
  fi

  echo "Reload-driven update (build + install + restart)."
  print_status "$wt" || true
  echo
  echo "==> npm run build:dev (in $wt)"
  (cd "$wt" && npm run build:dev)

  if [[ -n "$(zotero_pids_for_profile "$WT_PROFILE")" ]]; then
    echo
    echo "==> Stopping Zotero so the addon registry can be rewritten"
    ARG_PATH="$wt" cmd_stop
    sleep 2
  fi

  echo
  echo "==> Installing beaver.xpi into profile"
  install_beaver_xpi "$wt" "$WT_PROFILE"

  echo
  echo "==> Starting Zotero with the new build"
  start_zotero_direct "$wt"
}

# Optional: start npm start for human UI iteration with hot-reload on save.
cmd_watch() {
  local wt
  wt="$(resolve_wt "$ARG_PATH")"
  ensure_identity "$wt" || die "this worktree has no Zotero profile configured"

  if serve_running_for_wt "$wt"; then
    echo "Hot-reload watcher already running for this worktree."
    print_status "$wt" || true
    return 0
  fi

  local pids
  pids="$(zotero_pids_for_profile "$WT_PROFILE")"
  if [[ -n "$pids" ]]; then
    echo "Zotero is already running without a watcher (pid $pids)."
    echo "npm start would try to launch another instance against the same profile."
    echo
    local do_switch=0
    if [[ -t 0 ]]; then
      if ask_yes "Stop it and start npm start (hot-reload) instead?"; then
        do_switch=1
      fi
    else
      echo "Non-interactive: refusing to attach watch to a live instance."
      echo "Run:  $0 stop $wt && $0 watch $wt"
      return 1
    fi
    if [[ "$do_switch" -ne 1 ]]; then
      echo "Aborted. Stay reload-driven with:  $0 reload $wt"
      return 1
    fi
    ARG_PATH="$wt" cmd_stop
    sleep 2
  fi

  echo "Starting optional hot-reload watcher (npm start)."
  print_status "$wt" || true
  echo
  start_npm_start_bg "$wt"
  echo "When up: curl -sS -X POST http://127.0.0.1:$WT_HTTP/beaver/test/ping -H 'Content-Type: application/json' -d '{}'"
  echo "Back to reload-driven mode later:  $0 stop $wt && $0 open $wt"
}

kill_tree() {
  local pid="$1"
  # Best-effort: kill process group children of npm start that belong to this wt.
  kill "$pid" 2>/dev/null || true
}

cmd_stop() {
  local wt
  wt="$(resolve_wt "$ARG_PATH")"
  ensure_identity "$wt" || die "this worktree has no Zotero profile configured"

  local pids
  pids="$(zotero_pids_for_profile "$WT_PROFILE")"
  if [[ -z "$pids" ]]; then
    echo "No Zotero process for profile $(profile_short "$WT_PROFILE")"
  else
    echo "Quitting Zotero PIDs: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi

  # Optionally stop orphaned npm start / zotero-plugin serve for this worktree path.
  local npids
  npids="$(serve_pids_for_wt "$wt" | tr '\n' ' ' | sed 's/ *$//')"
  if [[ -n "$npids" ]]; then
    echo "Also stopping serve/npm processes for this worktree: $npids"
    # shellcheck disable=SC2086
    kill $npids 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -9 $npids 2>/dev/null || true
  fi
  echo "Done."
}

cmd_fix_db() {
  local wt
  wt="$(resolve_wt "$ARG_PATH")"
  ensure_identity "$wt" || die "this worktree has no Zotero profile configured"

  echo "Worktree : $wt"
  echo "Profile  : $WT_PROFILE"
  echo "Data dir : $WT_DATADIR"
  local pids
  pids="$(zotero_pids_for_profile "$WT_PROFILE")"
  if [[ -n "$pids" ]]; then
    echo "DB hint  : $(db_stall_hint "$WT_DATADIR" running)"
  else
    echo "DB hint  : $(db_stall_hint "$WT_DATADIR" stopped)"
  fi
  echo

  if [[ -n "$pids" ]]; then
    echo "Zotero is running (pid $pids). It must be quit before the DB can be fixed"
    echo "(cannot checkpoint while Zotero holds the SQLite lock — and a live WAL is normal)."
    if ! ask_yes "Quit this worktree's Zotero (and watcher if any) now?"; then
      echo "Aborted. Quit the stuck window yourself, then re-run: $0 fix-db $wt"
      return 1
    fi
    ARG_PATH="$wt" cmd_stop
    # wait until sqlite lock is gone
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if ! lsof -- "$WT_DATADIR/zotero.sqlite" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    if lsof -- "$WT_DATADIR/zotero.sqlite" >/dev/null 2>&1; then
      die "zotero.sqlite is still locked — force-quit the stuck Zotero and retry"
    fi
  fi

  echo "==> Stripping stale locks / recovery markers"
  zc_strip_clone_artifacts "$WT_PROFILE" "$WT_DATADIR"
  echo "==> Checkpointing / verifying databases"
  if ! zc_normalize_databases "$WT_DATADIR"; then
    die "zotero.sqlite failed integrity_check even after dropping a bad WAL.
Restore from a backup in the data dir (zotero.sqlite.bak) or re-clone:
  rm -rf \"$WT_PROFILE\" \"$WT_DATADIR\"
  WORKTREE_DIR=$wt $SCRIPT_DIR/setup-worktree.sh $WT_BRANCH"
  fi

  echo
  echo "Databases look clean. Next launch should skip the integrity stall."
  if ask_yes "Start Zotero for this worktree now (no watcher)?"; then
    start_zotero_direct "$wt"
  else
    echo "Start later with:  $0 open $wt"
  fi
}

cmd_status() {
  local wt
  wt="$(resolve_wt "$ARG_PATH")"
  print_status "$wt"
}

usage() {
  sed -n '3,35p' "$0" | sed 's/^# \{0,1\}//'
}

case "$CMD" in
  -h|--help|help) usage ;;
  list)           cmd_list ;;
  status)         cmd_status ;;
  open|start)     cmd_open ;;
  reload|rebuild) cmd_reload ;;
  watch)          cmd_watch ;;
  stop)           cmd_stop ;;
  fix-db|fixdb)  cmd_fix_db ;;
  *)
    # Allow: scripts/worktree/worktree-zotero.sh /path/to/wt
    if [[ -d "$CMD" ]]; then
      ARG_PATH="$CMD"
      cmd_status
    else
      die "unknown command: $CMD (try: list | status | open | reload | watch | stop | fix-db)"
    fi
    ;;
esac

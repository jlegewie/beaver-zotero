#!/usr/bin/env bash
#
# Shared helpers for scripts that clone a Zotero profile + data dir
# (setup-worktree.sh, start-test-zotero.sh). Source this file; it defines
# functions only.
#
# Background — why a clone needs fixing up:
#
#   Zotero 10 runs its databases in WAL mode and truncates the -wal file on a
#   clean shutdown. At startup it treats a NON-EMPTY zotero.sqlite-wal as
#   evidence the last session didn't close cleanly and runs a full
#   PRAGMA integrity_check before the UI becomes usable, showing
#   "Checking database integrity…" in the items pane.
#
#   A file-by-file copy of a RUNNING Zotero always hits that path, because the
#   live WAL is non-empty. Worse, cp copies the .sqlite and its -wal at
#   different instants, so if the source checkpoints in between, the copy pairs
#   a database with a WAL that no longer belongs to it. Zotero reports that as
#   corruption and recovers by restarting itself — which, under a
#   `zotero-plugin serve` dev loop, looks like a hung launch.
#
#   zc_normalize_databases() removes both problems up front: it checkpoints
#   each cloned database so the clone always starts clean, and a bad copy fails
#   here, with a clear message, instead of mid-launch.

# Absolute path to a usable sqlite3, printed on stdout. Prefers the system
# binary over whatever is first on PATH (conda/homebrew builds are often older).
zc_sqlite3() {
  if [[ -x /usr/bin/sqlite3 ]]; then
    echo /usr/bin/sqlite3
  elif command -v sqlite3 >/dev/null 2>&1; then
    command -v sqlite3
  else
    return 1
  fi
}

# Delete files that are meaningless or actively harmful once copied:
#   - profile/data locks: always stale in a copy.
#   - *.is.corrupt markers and *.repair.tmp / *.check.tmp files: Zotero's
#     database-recovery state. A stale pending repair would let Zotero swap an
#     older database copy over the clone's on first launch.
#
# Usage: zc_strip_clone_artifacts <profile-dir> <data-dir>
zc_strip_clone_artifacts() {
  local d
  for d in "$@"; do
    [[ -d "$d" ]] || continue
    find "$d" -maxdepth 1 \
      \( -name '.parentlock' -o -name 'parent.lock' -o -name 'lock' \) \
      -delete 2>/dev/null || true
    find "$d" -maxdepth 1 \
      \( -name '*.is.corrupt' -o -name '*.repair.tmp*' -o -name '*.check.tmp*' \) \
      -delete 2>/dev/null || true
  done
}

# Checkpoint one cloned database and verify it.
#
# sqlite3 replays the -wal into the database and truncates it on a clean close,
# so afterwards the clone looks like a cleanly shut down Zotero.
#
# Usage:  zc_normalize_database <db-path> <sqlite3-bin>
# Prints: nothing on success; the failing check output on stderr for exit 2.
# Exit:   0 database is intact
#         1 the copied WAL didn't belong to the database and was dropped;
#           the database itself is intact but may be missing the source's
#           last few transactions
#         2 the database is unusable
zc_normalize_database() {
  local db="$1" sq="$2" out=""

  out="$("$sq" "$db" 'PRAGMA integrity_check;' 2>&1)" || true
  if [[ "$out" == "ok" ]]; then
    rm -f "$db-wal" "$db-shm"
    return 0
  fi

  # A database that only fails WITH its WAL was paired with the wrong one by a
  # racy copy. Dropping the WAL costs at most the source's most recent writes.
  if [[ -e "$db-wal" ]]; then
    rm -f "$db-wal" "$db-shm"
    out="$("$sq" "$db" 'PRAGMA integrity_check;' 2>&1)" || true
    if [[ "$out" == "ok" ]]; then
      # The re-check opened the database again, so clear the (empty) journal
      # files it left behind.
      rm -f "$db-wal" "$db-shm"
      return 1
    fi
  fi

  printf '%s\n' "$out" >&2
  return 2
}

# Normalize every top-level *.sqlite in a freshly cloned data dir.
#
# ONLY call this on a clone that was just made. Zotero 10 holds an exclusive
# SQLite lock while running, so pointing this at a data dir whose Zotero is live
# would fail every check and delete WAL files out from under it.
#
# Usage: zc_normalize_databases <data-dir>
# Exit:  0 all databases usable (individual WAL drops are reported, not fatal)
#        1 zotero.sqlite is unusable — the caller should abort
zc_normalize_databases() {
  # Note: `failed`, not `status` -- `status` is read-only in zsh, and these
  # helpers are sometimes sourced into an interactive shell for debugging.
  local datadir="$1" sq db name rc failed=0

  if ! sq="$(zc_sqlite3)"; then
    cat >&2 <<'WARN'
!!  sqlite3 not found -- leaving the cloned WAL files in place. Zotero will
!!  treat the clone as an unclean shutdown and run an integrity check on its
!!  first launch, which delays startup behind "Checking database integrity…".
WARN
    return 0
  fi

  for db in "$datadir"/*.sqlite; do
    [[ -e "$db" ]] || continue
    name="$(basename "$db")"
    rc=0
    zc_normalize_database "$db" "$sq" || rc=$?
    case "$rc" in
      0) echo "    (ok)      $name" ;;
      1) echo "    (dropped) $name -- copied WAL didn't match; the clone may be missing the source's most recent changes" ;;
      *)
        if [[ "$name" == "zotero.sqlite" ]]; then
          echo "    (FAILED)  $name" >&2
          failed=1
        else
          echo "    (warn)    $name failed its integrity check -- Zotero will rebuild or report it" >&2
        fi
        ;;
    esac
  done

  return $failed
}

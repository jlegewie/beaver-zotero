#!/usr/bin/env bash
#
# Zotero 11 hardening prefs for a worktree profile (sourced, not executed).
#
# Zotero 11 (Firefox 153) ships two temporary overrides that keep older plugins
# working. Zotero intends to remove both:
#   security.allow_unsafe_subscript_loads = true   (Zotero default; Firefox: false)
#     -> plugin loadSubScript() of jar:/file: URIs works without allowUnsafeURL
#   security.chrome_baseline_csp.enabled = false   (Zotero default; Firefox: true)
#     -> inline scripts / on* handlers in chrome documents still run
#
# Modes write the Firefox values into the profile's user.js so a run shows what
# breaks once the overrides are gone:
#   on         both prefs
#   subscript  only security.allow_unsafe_subscript_loads=false
#   csp        only security.chrome_baseline_csp.enabled=true
#   off        neither
# With the CSP pref, a Zotero build may break in its own chrome documents
# (Zotero's Preferences window; as of Zotero 11.0 main @44fe83d, Zotero does not
# start at all). Use `subscript` to test the loader change on its own.
# Both prefs are unknown to Zotero 7-10, so the block is harmless there.
#
# The profile's Zotero must be stopped: Zotero rewrites prefs.js on exit.

Z11_HARDENING_BEGIN='// BEGIN beaver zotero11-hardening (scripts/worktree)'
Z11_HARDENING_END='// END beaver zotero11-hardening'

# z11_set_hardening <profile-dir> on|subscript|csp|off
z11_set_hardening() {
  local profile="$1" mode="$2"
  [[ -d "$profile" ]] || { echo "profile not found: $profile" >&2; return 1; }
  python3 - "$profile" "$mode" "$Z11_HARDENING_BEGIN" "$Z11_HARDENING_END" <<'PY'
import pathlib, re, sys
profile, mode, begin, end = sys.argv[1:]
prefs = {
    "security.allow_unsafe_subscript_loads": "false",
    "security.chrome_baseline_csp.enabled": "true",
}
selected = {
    "on": list(prefs),
    "subscript": ["security.allow_unsafe_subscript_loads"],
    "csp": ["security.chrome_baseline_csp.enabled"],
    "off": [],
}[mode]

user_js = pathlib.Path(profile) / "user.js"
text = user_js.read_text() if user_js.exists() else ""
block = re.compile(r"^" + re.escape(begin) + r"\n.*?^" + re.escape(end) + r"\n?", re.M | re.S)
text = block.sub("", text)
if selected:
    if text and not text.endswith("\n"):
        text += "\n"
    text += begin + "\n"
    text += "".join(f'user_pref("{k}", {prefs[k]});\n' for k in selected)
    text += end + "\n"
if text.strip():
    user_js.write_text(text)
elif user_js.exists():
    user_js.unlink()

# user.js values are copied into prefs.js at runtime, and prefs.js wins once
# user.js no longer mentions them, so a pref left out has to go there too.
dropped = [k for k in prefs if k not in selected]
prefs_js = pathlib.Path(profile) / "prefs.js"
if dropped and prefs_js.exists():
    lines = prefs_js.read_text().splitlines(keepends=True)
    kept = [l for l in lines if not any(f'user_pref("{k}"' in l for k in dropped)]
    prefs_js.write_text("".join(kept))
PY
}

# z11_hardening_state <profile-dir>  ->  prints on, subscript, csp or off
z11_hardening_state() {
  local user_js="$1/user.js" subscript=0 csp=0
  if [[ -f "$user_js" ]] && grep -qF "$Z11_HARDENING_BEGIN" "$user_js"; then
    grep -qF 'security.allow_unsafe_subscript_loads' "$user_js" && subscript=1
    grep -qF 'security.chrome_baseline_csp.enabled' "$user_js" && csp=1
  fi
  case "$subscript$csp" in
    11) echo on ;;
    10) echo subscript ;;
    01) echo csp ;;
    *)  echo off ;;
  esac
}

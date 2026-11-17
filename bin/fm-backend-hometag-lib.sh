#!/usr/bin/env bash
# bin/fm-backend-hometag-lib.sh - shared per-installation home-tag derivation
# for session-provider backends whose container has ONE namespace shared by
# every firstmate home on the machine, with no native per-home split (cmux's
# one app-global workspace list, zellij's one shared "firstmate" session's
# tab bar, tern's one window-global session list). Without a per-home
# discriminator embedded in the actual title/name, two firstmate homes (two
# secondmates, a primary plus a secondmate, or two independent primary
# installations) whose task ids
# happen to collide can send/peek/close each other's tabs - the gap a
# captain-directed no-mistakes review gate caught for cmux
# (docs/cmux-backend.md) and this same tag mechanism was later ported to
# zellij to close for the same reason (docs/zellij-backend.md "Home-scoped
# tab titles").
#
# fm_backend_hometag() derives a short, stable tag: a readable prefix
# ("firstmate" for the primary home, "2ndmate-<id>" for a secondmate home
# carrying .fm-secondmate-home) plus a short hash of the resolved FM_ROOT
# path, so distinct installations - including multiple primaries on one
# machine - never collide even though they share one backend-global
# namespace. Callers source this file AFTER resolving their own
# FM_HOME/FM_ROOT fallbacks (every adapter already does this for its own
# purposes before any other function runs).
#
# Moving/relocating a firstmate installation changes its FM_ROOT path and
# therefore its tag; titles created under the old tag simply stop matching -
# an accepted limitation, no worse than the existing fact that a task's
# recorded absolute worktree path does not survive a move either.

FM_BACKEND_HOMETAG_SECONDMATE_MARKER=".fm-secondmate-home"

fm_backend_hometag() {
  local marker="$FM_HOME/$FM_BACKEND_HOMETAG_SECONDMATE_MARKER" id prefix root hash
  # A tag memoized for exactly this home and root (fm_backend_hometag_memoize)
  # is the answer: the derivation below spawns a hash pipeline on every call.
  case "${FM_BACKEND_HOMETAG_MEMO:-}" in
    "$FM_HOME|$FM_ROOT|"?*) printf '%s' "${FM_BACKEND_HOMETAG_MEMO#"$FM_HOME|$FM_ROOT|"}"; return 0 ;;
  esac
  if [ -f "$marker" ]; then
    id=$(tr -d '[:space:]' < "$marker" 2>/dev/null)
    if [ -n "$id" ]; then
      prefix="2ndmate-$id"
    else
      prefix="firstmate"
    fi
  else
    prefix="firstmate"
  fi
  root=$(cd "$FM_ROOT" 2>/dev/null && pwd -P) || root=$FM_ROOT
  if command -v shasum >/dev/null 2>&1; then
    hash=$(printf '%s' "$root" | shasum -a 256 | awk '{print substr($1,1,8)}')
  elif command -v sha256sum >/dev/null 2>&1; then
    hash=$(printf '%s' "$root" | sha256sum | awk '{print substr($1,1,8)}')
  else
    hash=$(printf '%s' "$root" | cksum | awk '{printf "%08x", $1}')
  fi
  printf '%s-%s' "$prefix" "$hash"
}

# fm_backend_hometag_memoize: derive the tag once in the CALLING shell and
# export it, keyed by the exact FM_HOME and FM_ROOT it was derived for. Most
# callers read the tag inside a command substitution, where nothing they compute
# survives, so an adapter that asks for it many times per command (hc labels and
# verifies every terminal with it) calls this once when it is sourced. Child
# scripts inherit the export; a different home or root never matches the key and
# derives its own.
fm_backend_hometag_memoize() {
  local tag
  case "${FM_BACKEND_HOMETAG_MEMO:-}" in
    "${FM_HOME:-}|${FM_ROOT:-}|"?*) return 0 ;;
  esac
  [ -n "${FM_HOME:-}" ] && [ -n "${FM_ROOT:-}" ] || return 0
  tag=$(fm_backend_hometag) || return 0
  [ -n "$tag" ] || return 0
  export FM_BACKEND_HOMETAG_MEMO="$FM_HOME|$FM_ROOT|$tag"
}

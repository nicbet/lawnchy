#!/usr/bin/env bash
# Builds the fictional repos shown in the README's demo, under /tmp/lawnchy-demo.
set -euo pipefail

demo=/tmp/lawnchy-demo
rm -rf "$demo"
mkdir -p "$demo/origins" "$demo/code/acme" "$demo/code/tools" "$demo/xdg/lazygit"

# Ignore the machine's git config.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=Demo GIT_AUTHOR_EMAIL=demo@example.com
export GIT_COMMITTER_NAME=Demo GIT_COMMITTER_EMAIL=demo@example.com
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=advice.detachedHead GIT_CONFIG_VALUE_0=false

mkdir -p "$demo/xdg/lawnchy"
cat > "$demo/xdg/lawnchy/config.toml" <<'TOML'
[launchables]
code = { key = "c", command = "code ." }
xpo = { key = "x", command = "xpo board" }
yazi = { key = "y", command = "yazi" }
TOML

# Keep lazygit's first-run and upgrade popups out of the demo.
printf 'startuppopupversion: 99\nlastversion: 999.0.0\n' > "$demo/xdg/lazygit/state.yml"

commit() { # file message
  echo "$2" >> "$1"
  git add -A
  git commit -qm "$2"
}

# Creates a repo with an upstream at $demo/code/<path>.
clone_repo() { # path
  local name="${1//\//-}"
  git init -q -b main --bare "$demo/origins/$name.git"
  git clone -q "$demo/origins/$name.git" "$demo/code/$1" 2>/dev/null
  cd "$demo/code/$1"
  git checkout -qb main 2>/dev/null || true
  commit README.md "Initial commit"
  git push -qu origin main
}

# Adds an upstream commit and fetches it, leaving the clone one commit behind.
fall_behind() { # path
  local name="${1//\//-}"
  local other="$demo/origins/$name-other"
  git clone -q "$demo/origins/$name.git" "$other"
  (cd "$other" && commit NEWS.md "Upstream change" && git push -q origin main)
  rm -rf "$other"
  git -C "$demo/code/$1" fetch -q
}

# Has uncommitted work, a hotfix worktree, and branches in every sync state.
clone_repo acme/api
commit server.ts "Add server"
git push -q
git branch feature/billing
git branch experiment/rate-limits
git branch --track feature/search origin/main >/dev/null
git push -q origin feature/billing
git branch -q --set-upstream-to=origin/feature/billing feature/billing
git checkout -q feature/billing && commit billing.ts "Add billing" && git checkout -q main
git push -q origin main:refs/heads/old-release
git branch --track old-release origin/old-release >/dev/null
git push -q origin --delete old-release
git fetch -q --prune
git worktree add -q ../api-hotfix -b hotfix/login-crash
echo "// patch" >> ../api-hotfix/server.ts
echo "// wip" >> server.ts
git add server.ts
echo "// more wip" >> server.ts
echo "notes" > TODO.md

# Behind its upstream.
clone_repo acme/web
fall_behind acme/web

# Ahead of its upstream.
clone_repo acme/mobile
commit app.ts "Add app shell"

# Nothing to report: these are hidden by boring mode.
clone_repo acme/docs
clone_repo tools/deploy
clone_repo tools/lint-rules
git -C "$demo/code/tools/deploy" branch local-notes

# Never pushed anywhere.
mkdir -p "$demo/code/sandbox"
cd "$demo/code/sandbox"
git init -q -b main
commit notes.md "First notes"
echo "idea" >> notes.md

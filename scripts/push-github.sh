#!/usr/bin/env bash
# ============================================================================
# Push this repository to GitHub
# ----------------------------------------------------------------------------
# Usage:
#   GH_TOKEN=<fine-grained personal access token> ./scripts/push-github.sh
#
# The token needs, on the target repository only:
#   • Contents: Read and write      (to push the commit)
#   • Metadata: Read                (granted automatically)
#
# Nothing is stored: the token is used for this one push and then dropped from
# the remote URL again, so it does not end up in .git/config.
# ============================================================================
set -euo pipefail

OWNER="${GH_OWNER:-aditya-junior-developer}"
REPO="${GH_REPO:-shinzora}"
BRANCH="${GH_BRANCH:-main}"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN is not set." >&2
  echo "Create a fine-grained token with Contents: Read and write on ${OWNER}/${REPO}," >&2
  echo "then run:  GH_TOKEN=<token> ./scripts/push-github.sh" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

git rev-parse --git-dir >/dev/null 2>&1 || { echo "Not a git repository." >&2; exit 1; }
[[ -n "$(git status --porcelain)" ]] && echo "note: working tree has uncommitted changes; pushing the commit history only"

echo "Pushing $(git rev-parse --short HEAD) to ${OWNER}/${REPO}:${BRANCH}"
git push "https://x-access-token:${GH_TOKEN}@github.com/${OWNER}/${REPO}.git" "HEAD:${BRANCH}" --force

# If a remote already exists, point it at the plain (token-free) URL.
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "https://github.com/${OWNER}/${REPO}.git"
else
  git remote add origin "https://github.com/${OWNER}/${REPO}.git"
fi

echo "Done. https://github.com/${OWNER}/${REPO}"

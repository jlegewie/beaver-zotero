#!/usr/bin/env bash
# Comments on the pull requests and issues that shipped in release $TAG.
#
# A pull request qualifies when it is merged and contains a commit between the
# previous v* tag and $TAG; pull requests labelled "dependencies" are skipped.
# An issue qualifies when a qualifying pull request, or a commit message in
# that range, closes it.
#
# Env: TAG, REPO (owner/name), GH_TOKEN. DRY_RUN=1 lists the targets without
# posting.
set -euo pipefail

: "${TAG:?}" "${REPO:?}"

if ! prev=$(git describe --tags --abbrev=0 --match 'v*' "$TAG^" 2>/dev/null); then
  echo "No tag before $TAG; nothing to comment on."
  exit 0
fi
echo "Commits $prev..$TAG"

query='query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        associatedPullRequests(first: 10) {
          nodes {
            number
            merged
            labels(first: 20) { nodes { name } }
            closingIssuesReferences(first: 25) {
              nodes { number repository { nameWithOwner } }
            }
          }
        }
      }
    }
  }
}'
filter='.data.repository.object.associatedPullRequests.nodes[]
  | select(.merged and ([.labels.nodes[].name] | index("dependencies") | not))
  | .number,
    (.closingIssuesReferences.nodes[]
      | select(.repository.nameWithOwner == $ENV.REPO) | .number)'

found=$(mktemp)
for sha in $(git rev-list "$prev..$TAG"); do
  gh api graphql -f query="$query" -f owner="${REPO%/*}" -f name="${REPO#*/}" \
    -f oid="$sha" --jq "$filter" >>"$found"
done
git log --format=%B "$prev..$TAG" |
  grep -oiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?):? #[0-9]+' |
  grep -oE '[0-9]+$' >>"$found" || true
numbers=$(sort -nu "$found")

if [ -z "$numbers" ]; then
  echo "Nothing to comment on."
  exit 0
fi

body=":rocket: _This ticket has been resolved in $TAG. See [Release $TAG](https://github.com/$REPO/releases/tag/$TAG) for release notes._"
failed=0
for n in $numbers; do
  if [ "${DRY_RUN:-}" = 1 ]; then
    gh api "repos/$REPO/issues/$n" \
      --jq '"would comment on #\(.number) (\(if .pull_request then "PR" else "issue" end), \(.state)): \(.title)"'
  elif gh api "repos/$REPO/issues/$n/comments" -f body="$body" --silent; then
    echo "Commented on #$n"
  else
    echo "::warning::Could not comment on #$n"
    failed=1
  fi
done
exit "$failed"

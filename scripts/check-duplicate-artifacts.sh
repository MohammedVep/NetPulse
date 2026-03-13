#!/usr/bin/env bash
set -euo pipefail

offending_files=()

while IFS= read -r -d '' path; do
  filename="${path##*/}"
  if [[ "$filename" =~ [[:space:]][0-9]+(\.[^/]+)?$ ]]; then
    offending_files+=("$path")
  fi
done < <(git ls-files -z)

if [ "${#offending_files[@]}" -gt 0 ]; then
  echo "Duplicate artifact filenames detected in tracked files:" >&2
  printf '  %s\n' "${offending_files[@]}" >&2
  echo >&2
  echo "Rename or remove these files before merging." >&2
  exit 1
fi

echo "No tracked duplicate artifact filenames detected."

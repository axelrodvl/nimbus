#!/usr/bin/env bash
# Собирает текст GitHub Release из docs/releases/vX.Y.Z.md + блок установки + ссылка на полный список изменений.
#   scripts/release-notes.sh vX.Y.Z            — печатает итоговый текст (CI кладёт его в релиз)
#   scripts/release-notes.sh --draft [vX.Y.Z]   — набросок: коммиты с прошлого тега (для написания файла вручную)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--draft" ]]; then
  prev=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
  echo "Commits since ${prev:-the beginning} (rewrite as user-facing bullets, see docs/releases/TEMPLATE.md):" >&2
  git log --no-merges --pretty='- %s' ${prev:+$prev..HEAD}
  exit 0
fi

tag="${1:?usage: release-notes.sh vX.Y.Z | --draft}"
file="docs/releases/${tag}.md"
[[ -f "$file" ]] || { echo "missing $file — write the release notes (see docs/releases/TEMPLATE.md)" >&2; exit 1; }

# Единый стиль: разделы только из разрешённого набора и в фиксированном порядке; без заглушек шаблона.
order=("## ✨ New" "## ⚡ Improved" "## 🐛 Fixed" "## ⚠️ Upgrade notes")
last=-1
while IFS= read -r h; do
  idx=-1
  for i in "${!order[@]}"; do [[ "$h" == "${order[$i]}" ]] && idx=$i; done
  (( idx >= 0 )) || { echo "$file: unknown section '$h'" >&2; exit 1; }
  (( idx > last )) || { echo "$file: section '$h' is out of order or duplicated" >&2; exit 1; }
  last=$idx
done < <(grep '^## ' "$file")
(( last >= 0 )) || { echo "$file: no sections" >&2; exit 1; }
grep -q '^> ' "$file" || { echo "$file: missing the one-sentence intro ('> ...')" >&2; exit 1; }
if grep -q 'what was added\|what got better\|what was broken\|One sentence' "$file"; then
  echo "$file: template placeholders left in" >&2; exit 1
fi

repo="${GITHUB_REPOSITORY:-axelrodvl/nimbus}"
owner="${repo%%/*}"; owner="${owner,,}"
prev=$(git describe --tags --abbrev=0 --match 'v*' "${tag}^" 2>/dev/null || true)

cat "$file"
cat <<MD

---

## 📦 Install

Requires only Docker with Compose v2.

\`\`\`sh
unzip nimbus-${tag}.zip && cd nimbus
cp .env.example .env   # edit if needed
docker compose up -d
\`\`\`

Open <http://localhost:8000>. Image: \`ghcr.io/${owner}/nimbus:${tag#v}\` (linux/amd64, linux/arm64).
\`Caddyfile.example\` is an optional reverse proxy with TLS.
MD
[[ -n "$prev" ]] && printf '\n**Full changelog:** https://github.com/%s/compare/%s...%s\n' "$repo" "$prev" "$tag"
exit 0

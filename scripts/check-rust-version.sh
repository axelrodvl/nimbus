#!/usr/bin/env bash
# Версия Rust одна: backend/rust-toolchain.toml == CI == Dockerfile.
set -euo pipefail
cd "$(dirname "$0")/.."
want=$(sed -n 's/^channel = "\(.*\)"/\1/p' backend/rust-toolchain.toml)
ci=$(sed -n 's#.*dtolnay/rust-toolchain@\(.*\)#\1#p' .github/workflows/ci.yml | sort -u)
docker=$(sed -n 's#^FROM rust:\([0-9.]*\)-bookworm.*#\1#p' Dockerfile)
[ -n "$want" ] || { echo "нет channel в backend/rust-toolchain.toml"; exit 1; }
[ "$ci" = "$want" ] || { echo "CI: '$ci', ожидалось $want"; exit 1; }
[ "$docker" = "$want" ] || { echo "Dockerfile: '$docker', ожидалось $want"; exit 1; }
echo "rustc $want: toolchain.toml = CI = Dockerfile"

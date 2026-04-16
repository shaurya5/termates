#!/usr/bin/env bash
# Build abduco for the current platform and drop the binary into ./binaries/.
#
# Run this before packaging releases. The output binary is named
# abduco-<platform>-<arch> where:
#   platform ∈ { darwin, linux }
#   arch     ∈ { x64, arm64 }
#
# These names match process.platform / process.arch in Node, so
# persistence-backend.js can find the right binary at runtime.
#
# For a cross-platform release, run this once per target triplet (or use the
# GitHub Actions matrix when we have one).

set -euo pipefail

ABDUCO_VERSION="0.6"
ABDUCO_URL="https://www.brain-dump.org/projects/abduco/abduco-${ABDUCO_VERSION}.tar.gz"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/binaries"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termates-abduco-build.XXXXXX")"
trap 'rm -rf "${WORK_DIR}"' EXIT

# Detect platform/arch in the same form Node.js uses so the output name
# matches what persistence-backend.js probes for.
case "$(uname -s)" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux"  ;;
  *) echo "Unsupported platform $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64"   ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported arch $(uname -m)"; exit 1 ;;
esac

OUT_BINARY="${OUT_DIR}/abduco-${PLATFORM}-${ARCH}"
mkdir -p "${OUT_DIR}"

echo "==> Fetching abduco ${ABDUCO_VERSION}"
cd "${WORK_DIR}"
curl -fL --silent --show-error "${ABDUCO_URL}" -o abduco.tar.gz
tar xzf abduco.tar.gz
cd "abduco-${ABDUCO_VERSION}"

echo "==> Building"
# Append to CFLAGS rather than replacing it — the upstream config.mk sets
# -DVERSION=\"0.6\" there, and stomping on it breaks the build.
make CFLAGS="-O2 -Wall -DVERSION=\\\"${ABDUCO_VERSION}\\\"" >/dev/null
strip abduco || true

cp abduco "${OUT_BINARY}"
chmod +x "${OUT_BINARY}"

echo "==> Wrote ${OUT_BINARY} ($(du -h "${OUT_BINARY}" | cut -f1))"
"${OUT_BINARY}" -v | head -1 || true

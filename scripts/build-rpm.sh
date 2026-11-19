#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export RAGENT_LINUX_PACKAGE_FORMAT=rpm
export RAGENT_PACKAGE_BUILD_VERSION="${RAGENT_PACKAGE_BUILD_VERSION:-1.0.1}"
exec bash "$ROOT/scripts/build-deb.sh" "$@"

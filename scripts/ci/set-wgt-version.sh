#!/usr/bin/env bash
# Write a release version (X.Y.Z) into the widget element of app/config.xml before packaging.
# Usage: scripts/ci/set-wgt-version.sh 1.2.0 [path to config.xml]
set -euo pipefail

version="${1:?usage: set-wgt-version.sh X.Y.Z [config.xml]}"
config="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/app/config.xml}"

if [[ ! "${version}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "error: version must look like 1.2.0 without leading zeroes, got '${version}'." >&2
    exit 1
fi

major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"
if (( ${#major} > 3 || ${#minor} > 3 || ${#patch} > 5 || major > 255 || minor > 255 || patch > 65535 )); then
    echo "error: ${version} doesn't fit a Tizen version (major and minor <= 255, patch <= 65535)." >&2
    exit 1
fi

# Only the <widget> element's own version attribute; <?xml version="1.0"?> is left alone.
sed -E -i.bak "s/(<widget [^>]*[[:space:]]version=\")[^\"]*\"/\1${version}\"/" "${config}"
rm -f "${config}.bak"

if ! grep -Eq "<widget [^>]*[[:space:]]version=\"${version//./\\.}\"" "${config}"; then
    echo "error: could not set version ${version} in ${config}." >&2
    exit 1
fi
echo "Set ${config} to version ${version}."

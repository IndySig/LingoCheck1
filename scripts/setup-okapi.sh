#!/usr/bin/env bash
# Install a portable JRE + Okapi apps into .tools/ for LingoCheck (Linux / Render).
set -euo pipefail

OKAPI_VERSION="${OKAPI_VERSION:-1.48.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS"

echo "==> Tools dir: $TOOLS"

JAVA_HOME_DIR="$TOOLS/jre"
if [[ ! -x "$JAVA_HOME_DIR/bin/java" ]]; then
  echo "==> Downloading Eclipse Temurin 17 JRE (linux x64)..."
  JRE_TGZ="$TOOLS/temurin-jre17.tar.gz"
  curl -fsSL -o "$JRE_TGZ" \
    "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse?project=jdk"
  rm -rf "$TOOLS/jre-extract"
  mkdir -p "$TOOLS/jre-extract"
  tar -xzf "$JRE_TGZ" -C "$TOOLS/jre-extract"
  NESTED="$(find "$TOOLS/jre-extract" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  rm -rf "$JAVA_HOME_DIR"
  mv "$NESTED" "$JAVA_HOME_DIR"
  rm -f "$JRE_TGZ"
  rm -rf "$TOOLS/jre-extract"
else
  echo "==> JRE already present at $JAVA_HOME_DIR"
fi

"$JAVA_HOME_DIR/bin/java" -version

OKAPI_HOME="$TOOLS/okapi"
if [[ ! -f "$OKAPI_HOME/tikal.sh" && ! -d "$OKAPI_HOME/lib" ]]; then
  echo "==> Downloading Okapi apps ${OKAPI_VERSION} (linux)..."
  OK_ZIP="$TOOLS/okapi-apps.zip"
  curl -fsSL -o "$OK_ZIP" \
    "https://okapiframework.org/binaries/main/${OKAPI_VERSION}/okapi-apps_gtk2-linux-x86_64_${OKAPI_VERSION}.zip"
  rm -rf "$TOOLS/okapi-extract"
  mkdir -p "$TOOLS/okapi-extract"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$OK_ZIP" -d "$TOOLS/okapi-extract"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$OK_ZIP" "$TOOLS/okapi-extract" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  else
    echo "Need unzip or python3 to extract Okapi" >&2
    exit 1
  fi
  if [[ -f "$TOOLS/okapi-extract/tikal.sh" ]]; then
    SOURCE="$TOOLS/okapi-extract"
  else
    SOURCE="$(find "$TOOLS/okapi-extract" -maxdepth 2 -type f -name tikal.sh -printf '%h\n' | head -n 1)"
  fi
  if [[ -z "${SOURCE:-}" || ! -f "$SOURCE/tikal.sh" ]]; then
    echo "Okapi archive missing tikal.sh" >&2
    exit 1
  fi
  rm -rf "$OKAPI_HOME"
  mkdir -p "$OKAPI_HOME"
  # Copy contents so OKAPI_HOME always points at .tools/okapi
  shopt -s dotglob
  mv "$SOURCE"/* "$OKAPI_HOME"/
  shopt -u dotglob
  chmod +x "$OKAPI_HOME/tikal.sh" 2>/dev/null || true
  rm -f "$OK_ZIP"
  rm -rf "$TOOLS/okapi-extract"
else
  echo "==> Okapi already present at $OKAPI_HOME"
fi

export JAVA_HOME="$JAVA_HOME_DIR"
export OKAPI_HOME
export PATH="$JAVA_HOME/bin:$PATH"

echo "==> Verifying Tikal..."
"$JAVA_HOME/bin/java" -cp "$OKAPI_HOME/lib/*" net.sf.okapi.applications.tikal.Main -h | head -n 8

echo
echo "Okapi setup complete."
echo "  JAVA_HOME=$JAVA_HOME"
echo "  OKAPI_HOME=$OKAPI_HOME"

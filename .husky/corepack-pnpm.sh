if ! command -v pnpm >/dev/null 2>&1; then
  if ! command -v corepack >/dev/null 2>&1; then
    echo "pnpm is unavailable and Corepack is not in PATH" >&2
    exit 1
  fi

  HUSKY_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
  PATH="$HUSKY_DIR/bin:$PATH"
  export PATH
fi

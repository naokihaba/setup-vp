#!/usr/bin/env bash
set -eu

setup_vp_download() {
  setup_vp_url="$1"
  setup_vp_out="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 5 --max-time 60 "$setup_vp_url" -o "$setup_vp_out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$setup_vp_out" "$setup_vp_url"
  else
    echo "setup-vp: curl or wget is required to download files." >&2
    return 127
  fi
}

setup_vp_shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

setup_vp_export_env() {
  if [ -z "${SETUP_VP_ENV_FILE:-}" ]; then
    return 0
  fi

  setup_vp_name="$1"
  setup_vp_value="$2"
  printf "export %s=" "$setup_vp_name" >> "$SETUP_VP_ENV_FILE"
  setup_vp_shell_quote "$setup_vp_value" >> "$SETUP_VP_ENV_FILE"
  printf "\n" >> "$SETUP_VP_ENV_FILE"
}

setup_vp_install_viteplus_from() {
  setup_vp_url="$1"
  rm -f "$setup_vp_install_tmp"

  setup_vp_download "$setup_vp_url" "$setup_vp_install_tmp"
  VP_VERSION="$SETUP_VP_VERSION" VITE_PLUS_VERSION="$SETUP_VP_VERSION" bash "$setup_vp_install_tmp"
}

setup_vp_install_viteplus() {
  setup_vp_round=1
  while [ "$setup_vp_round" -le 2 ]; do
    for setup_vp_url in \
      "https://viteplus.dev/install.sh" \
      "https://raw.githubusercontent.com/voidzero-dev/vite-plus/main/packages/cli/install.sh"
    do
      echo "setup-vp: installing Vite+ ${SETUP_VP_VERSION} from ${setup_vp_url}"
      if setup_vp_install_viteplus_from "$setup_vp_url"; then
        return 0
      fi
      echo "setup-vp: install attempt failed; retrying if another source is available." >&2
    done
    setup_vp_round=$((setup_vp_round + 1))
    if [ "$setup_vp_round" -le 2 ]; then
      sleep 2
    fi
  done

  echo "setup-vp: failed to install Vite+ after retrying all installer URLs." >&2
  return 1
}

SETUP_VP_VERSION="${SETUP_VP_VERSION:-latest}"
SETUP_VP_NODE_VERSION="${SETUP_VP_NODE_VERSION:-lts}"
SETUP_VP_SETUP_REF="${SETUP_VP_SETUP_REF:-v1}"
setup_vp_install_tmp="${TMPDIR:-/tmp}/setup-vp-install.$$"
setup_vp_runtime_tmp="${TMPDIR:-/tmp}/setup-vp-gitlab-runtime.$$.mjs"
trap 'rm -f "$setup_vp_install_tmp" "$setup_vp_runtime_tmp"' EXIT

setup_vp_install_viteplus
export PATH="$HOME/.vite-plus/bin:$PATH"
setup_vp_export_env PATH "$PATH"

vp env use "$SETUP_VP_NODE_VERSION"

setup_vp_runtime_url="https://raw.githubusercontent.com/voidzero-dev/setup-vp/${SETUP_VP_SETUP_REF}/gitlab/setup-vp.mjs"
setup_vp_download "$setup_vp_runtime_url" "$setup_vp_runtime_tmp"
node "$setup_vp_runtime_tmp"

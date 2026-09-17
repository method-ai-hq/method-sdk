#!/bin/sh
# Install Method without Node, npm, or Python. No administrator access is needed.
set -eu
umask 077
base_url=${METHOD_DOWNLOAD_URL:-https://app.withmethod.ai/downloads/cli}
install_root=${METHOD_INSTALL_ROOT:-"$HOME/.local/share/method"}
bin_root=${METHOD_BIN_ROOT:-"$HOME/.local/bin"}
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo 'Method supports macOS and glibc Linux.' >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) echo 'Unsupported processor.' >&2; exit 1;; esac
target=$os-$arch
index=latest-$target.txt
[ "$#" -eq 0 ] || { echo "Usage: install.sh" >&2; exit 1; }
mkdir -p "$install_root/releases" "$bin_root"
tmp=$(mktemp -d "$install_root/.install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
get() { curl --fail --location --retry 3 --silent --show-error "$1" -o "$2"; }
checksum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
get "$base_url/$index" "$tmp/index"
version=$(awk '$1=="version" {print $2}' "$tmp/index")
case "$version" in ''|*[!0-9.]*) echo 'Invalid release manifest.' >&2; exit 1;; esac
expected=$(awk '$1=="sha256" {print $2}' "$tmp/index")
: > "$tmp/release.tar.gz"
while read -r kind name hash; do
 [ "$kind" = part ] || continue
 case "$name" in method-*.part[0-9]*) ;; *) echo 'Invalid release part.' >&2; exit 1;; esac
 case "$name" in */*|*..*) exit 1;; esac
 get "$base_url/$name" "$tmp/part"
 [ "$(checksum "$tmp/part")" = "$hash" ] || { echo 'Release part checksum failed.' >&2; exit 1; }
 cat "$tmp/part" >> "$tmp/release.tar.gz"
done < "$tmp/index"
[ "$(checksum "$tmp/release.tar.gz")" = "$expected" ] || { echo 'Release checksum failed.' >&2; exit 1; }
destination=$install_root/releases/$version-$target
mkdir "$tmp/release"
tar -xzf "$tmp/release.tar.gz" -C "$tmp/release"
"$tmp/release/method" --version
if [ ! -d "$destination" ]; then mv "$tmp/release" "$destination"; fi
 # Atomic link replacement. Running processes keep their existing release directory.
 ln -s "$destination/method" "$bin_root/.method-$$"
 mv -f "$bin_root/.method-$$" "$bin_root/method"
printf 'Method is ready: %s/method\n' "$destination"

#!/usr/bin/env bash
set -euo pipefail

# Instala apenas o aplicativo e seu atalho; preserva a base ~/.local/share/adelic.
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'Este pacote é para Linux x86_64.' >&2
  exit 1
fi
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $# -eq 0 ]]; then
  set -- "$repo_root"/release/Adelic-*-linux-x86_64.AppImage
  if [[ $# -ne 1 ]]; then
    echo 'Informe o AppImage a instalar: scripts/install-linux.sh /caminho/Adelic.AppImage' >&2
    exit 1
  fi
fi
if [[ $# -ne 1 || ! -f $1 ]]; then
  echo 'Informe um AppImage existente. Gere-o primeiro com npm run package:linux.' >&2
  exit 1
fi
app_source=$(realpath -- "$1")
if [[ -f $app_source.sha256 ]]; then
  (cd -- "$(dirname -- "$app_source")" && sha256sum -c -- "$(basename -- "$app_source").sha256")
fi

install_data_root=${XDG_DATA_HOME:-$HOME/.local/share}
install_bin_root=${ADELIC_BIN_DIR:-$HOME/.local/bin}
install_root="$install_data_root/adelic-desktop"
app_dest="$install_root/Adelic.AppImage"
launcher="$install_bin_root/adelic"
if [[ -e $launcher ]] && ! grep -q '^# Adelic desktop launcher$' "$launcher"; then
  echo "Já existe outro comando em $launcher. Use ADELIC_BIN_DIR para escolher outra pasta." >&2
  exit 1
fi
mkdir -p -- "$install_root" "$install_bin_root" "$install_data_root/applications"
temporary=$(mktemp "$install_root/.Adelic.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
cp -- "$app_source" "$temporary"
chmod 755 "$temporary"
mv -f -- "$temporary" "$app_dest"

# %q mantém caminhos com espaços e caracteres especiais como argumentos literais.
printf '#!/usr/bin/env bash\n# Adelic desktop launcher\nunset ELECTRON_RUN_AS_NODE\nexport APPIMAGE_EXTRACT_AND_RUN=1\nexec %q "$@"\n' "$app_dest" > "$launcher"
chmod 755 "$launcher"
desktop_exec=$(printf '%s' "$launcher" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g; s/%/%%/g')
desktop_icon=applications-development
if [[ -f $repo_root/desktop/assets/icon.png ]]; then
  mkdir -p -- "$install_data_root/icons/hicolor/512x512/apps"
  cp -- "$repo_root/desktop/assets/icon.png" "$install_data_root/icons/hicolor/512x512/apps/adelic.png"
  desktop_icon=adelic
fi
cat > "$install_data_root/applications/io.adelic.desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Adelic
Comment=Converse e coordene agentes de IA locais
Exec="$desktop_exec" %U
Icon=$desktop_icon
Terminal=false
Categories=Development;
StartupWMClass=io.adelic.desktop
EOF
printf 'Instalado em %s\nAbra pelo menu de aplicativos ou execute %s\n' "$app_dest" "$launcher"

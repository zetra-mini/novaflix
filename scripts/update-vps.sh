#!/bin/bash
# ==============================================================================
# NovaFlix Streaming - Script de Atualização e Reinicialização Automática VPS
# Uso: bash scripts/update-vps.sh [--reboot]
# ==============================================================================

set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=========================================================="
echo " 🚀 INICIANDO ATUALIZAÇÃO DO NOVAFLIX VIA GITHUB"
echo " 📂 Diretório: $ROOT_DIR"
echo " ⏰ Data: $(date)"
echo "=========================================================="

# 1. Configurações de rede e Git seguro
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:$HOME/.nvm/versions/node/$(node -v 2>/dev/null)/bin:$PATH"
git config --global http.postBuffer 524288000 || true
git config --global http.version HTTP/1.1 || true
git config --global core.compression 0 || true

# 2. Puxar commits mais recentes da branch main
echo "[1/5] Sincronizando código com o repositório oficial..."
git fetch --all --depth=1 || git fetch origin main --depth=1
git reset --hard origin/main

# 3. Limpeza de caches obsoletos para evitar tela de carregando infinita
echo "[2/5] Limpando caches antigos e temporários..."
rm -f data/catalog_cache.json
rm -f data/playlist.m3u.tmp* 2>/dev/null || true

# 4. Instalar ou atualizar dependências Node.js
echo "[3/5] Verificando dependências de produção (npm install)..."
npm install --omit=dev --no-audit --no-fund || npm install --omit=dev || true

# 5. Ajustar permissões
echo "[4/5] Ajustando permissões de arquivos..."
chmod -R 755 . 2>/dev/null || true
chmod +x scripts/*.sh 2>/dev/null || true

# 6. Reinicialização de serviços (PM2 / Nginx) ou da máquina inteira
echo "[5/5] Aplicando reinicialização..."

# Garante que PM2 (se instalado) salve o estado
PM2_BIN=$(which pm2 2>/dev/null || echo "/usr/local/bin/pm2")
if [ -f "$PM2_BIN" ] || command -v pm2 &> /dev/null; then
    echo "Reiniciando aplicação no PM2..."
    $PM2_BIN restart all 2>/dev/null || $PM2_BIN restart novaflix 2>/dev/null || true
    $PM2_BIN save 2>/dev/null || true
fi

# Reinicia serviço Nginx para garantir portas limpas
if command -v systemctl &> /dev/null; then
    sudo systemctl restart nginx 2>/dev/null || true
fi

# Se foi solicitada reinicialização completa da máquina VPS (--reboot)
if [ "$1" == "--reboot" ]; then
    echo "=========================================================="
    echo " 🔄 REINICIANDO A MÁQUINA VPS AGORA..."
    echo " O sistema voltará online automaticamente após o boot."
    echo "=========================================================="
    sleep 2
    sudo reboot 2>/dev/null || reboot 2>/dev/null || shutdown -r now 2>/dev/null || true
fi

echo "=========================================================="
echo " ✅ ATUALIZAÇÃO CONCLUÍDA COM SUCESSO!"
echo "=========================================================="
exit 0

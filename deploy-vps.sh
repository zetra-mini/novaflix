#!/bin/bash
# ==============================================================================
# NovaFlix Streaming v2.0.5 - Script de Instalação e Atualização Automática VPS
# Compatível com Ubuntu 20.04 / 22.04 / 24.04 e Debian 11 / 12
# Uso rápido (1 comando):
#   curl -fsSL https://raw.githubusercontent.com/zetra-mini/novaflix/main/deploy-vps.sh | sudo bash
# ==============================================================================

set -e

echo "=========================================================="
echo " 🍿 INICIANDO INSTALAÇÃO AUTOMÁTICA DO NOVAFLIX v2.0.5"
echo "=========================================================="

# 1. Atualizar repositórios e pacotes básicos do sistema
echo "[1/8] Atualizando pacotes do sistema operacional..."
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y curl wget git ufw htop nginx build-essential python3

# 2. Criar memória SWAP de 2GB automaticamente (se ainda não existir) e ativar BBR
echo "[2/8] Otimizando memória SWAP e rede TCP BBR para streaming..."
if ! sudo swapon --show | grep -q '/swapfile'; then
    if [ ! -f /swapfile ]; then
        sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile
    fi
    sudo swapon /swapfile || true
    if ! grep -q '/swapfile' /etc/fstab; then
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
    fi
fi

sudo modprobe tcp_bbr 2>/dev/null || true
if ! grep -q 'tcp_congestion_control = bbr' /etc/sysctl.conf 2>/dev/null; then
    echo "net.core.default_qdisc = fq" | sudo tee -a /etc/sysctl.conf > /dev/null
    echo "net.ipv4.tcp_congestion_control = bbr" | sudo tee -a /etc/sysctl.conf > /dev/null
    sudo sysctl -p 2>/dev/null || true
fi

# 3. Instalar Node.js 22 LTS (NodeSource)
if ! command -v node &> /dev/null; then
    echo "[3/8] Instalando Node.js 22 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "[3/8] Node.js já instalado ($(node -v))"
fi

# 4. Instalar PM2 para gerenciamento 24/7
echo "[4/8] Instalando PM2 (Process Manager)..."
sudo npm install -g pm2

# 5. Clonar ou atualizar o repositório NovaFlix v2.0.5 (com proteção Anti-Erro GnuTLS Ubuntu 20.04)
echo "[5/8] Baixando/Atualizando código oficial do NovaFlix v2.0.5..."
git config --global http.postBuffer 524288000 || true
git config --global http.maxRequestBuffer 100M || true
git config --global http.version HTTP/1.1 || true
git config --global core.compression 0 || true

if [ -f "./package.json" ] && grep -q "novaflix-streaming-web" "./package.json" 2>/dev/null; then
    APP_DIR="$(pwd)"
    git fetch --depth 1 origin main || true
    git reset --hard origin/main || true
else
    APP_DIR="/opt/novaflix"
    if [ -d "$APP_DIR/.git" ]; then
        cd "$APP_DIR"
        git fetch --depth 1 origin main || true
        git reset --hard origin/main || true
    else
        sudo rm -rf "$APP_DIR"
        sudo mkdir -p "$APP_DIR"
        if ! sudo git clone --depth 1 --single-branch --branch main https://github.com/zetra-mini/novaflix.git "$APP_DIR"; then
            echo "⚠️ Git GnuTLS instável nesta versão do Ubuntu. Baixando pacote direto via HTTPS Tarball..."
            sudo rm -rf "$APP_DIR"
            sudo mkdir -p "$APP_DIR"
            curl -fL --retry 5 --retry-delay 2 https://github.com/zetra-mini/novaflix/archive/refs/heads/main.tar.gz | sudo tar -xz -C "$APP_DIR" --strip-components=1
        fi
        sudo chown -R "$(whoami):$(whoami)" "$APP_DIR" 2>/dev/null || true
        cd "$APP_DIR"
    fi
fi

cd "$APP_DIR"
# Remove cache descompactado antigo para forçar leitura do novo catalog_cache.json.gz (v2.0.5)
rm -f data/catalog_cache.json

# 6. Instalar dependências da aplicação
echo "[6/8] Instalando dependências do projeto..."
npm install --omit=dev

# 7. Configurar Nginx como Proxy Reverso (Porta 80 -> Porta 3000) e Firewall
echo "[7/8] Configurando Nginx e Firewall para streaming otimizado..."
sudo tee /etc/nginx/sites-available/novaflix > /dev/null << 'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Otimizações de baixa latência para streaming VOD MP4/HLS e Range Requests
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/novaflix /etc/nginx/sites-enabled/novaflix
sudo nginx -t && sudo systemctl restart nginx || echo "Aviso: Nginx não pôde ser reiniciado, Node rodará direto na porta 3000."

sudo ufw allow 22/tcp || true
sudo ufw allow 80/tcp || true
sudo ufw allow 443/tcp || true
sudo ufw allow 3000/tcp || true
sudo ufw --force enable || true

# 8. Iniciar aplicação com PM2 e salvar para boot automático
echo "[8/8] Iniciando NovaFlix v2.0.5 com PM2..."
pm2 delete novaflix 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
STARTUP_CMD=$(pm2 startup systemd | grep "sudo env" || pm2 startup | grep "env PATH" || true)
if [ -n "$STARTUP_CMD" ]; then
    eval "$STARTUP_CMD" || true
fi

# Detectar IP público
SERVER_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || echo "IP_DA_SUA_VPS")

echo ""
echo "=========================================================="
echo " 🎉 NOVAFLIX v2.0.5 INSTALADO E RODANDO COM SUCESSO!"
echo "=========================================================="
echo " 📂 Diretório: ${APP_DIR}"
echo ""
echo " 🌐 Acesso Direto (Porta 80 padrão):"
echo "    🍿 Player Web:  http://${SERVER_IP}"
echo "    🛡️ Painel ADM:  http://${SERVER_IP}/admin"
echo ""
echo " 🔌 Acesso Porta Alternativa (3000):"
echo "    🍿 Player Web:  http://${SERVER_IP}:3000"
echo "    🛡️ Painel ADM:  http://${SERVER_IP}:3000/admin"
echo ""
echo " 🔑 Credenciais Padrão do Painel ADM:"
echo "    Usuário: admin"
echo "    Senha:   admin123"
echo "=========================================================="
echo " 💡 Comandos úteis do PM2:"
echo "    - Ver status:     pm2 status"
echo "    - Ver logs:       pm2 logs novaflix"
echo "    - Reiniciar:      pm2 restart novaflix"
echo "    - Atualizar VPS:  cd ${APP_DIR} && sudo bash deploy-vps.sh"
echo "=========================================================="

#!/bin/bash
# ==============================================================================
# NovaFlix Streaming - 1-Click Automated Infra Setup (Nginx + SSL Certbot)
# Uso: sudo bash ./scripts/setup-infra.sh <DOMAIN> [PORT]
# Exemplo: sudo bash ./scripts/setup-infra.sh app.meudominio.com 3000
# ==============================================================================

set -e

DOMAIN="$1"
PORT="${2:-3000}"

if [ -z "$DOMAIN" ]; then
    echo "❌ Erro: Domínio não informado!"
    echo "Uso: sudo bash ./scripts/setup-infra.sh <DOMAIN> [PORT]"
    exit 1
fi

echo "=========================================================="
echo " 🚀 INICIANDO CONFIGURAÇÃO AUTOMÁTICA DE INFRAESTRUTURA"
echo " 🌐 Domínio: $DOMAIN"
echo " 🔌 Porta Alvo: $PORT"
echo "=========================================================="

# 1. Instalação silenciosa de Nginx, Certbot e Plugin Certbot-Nginx
echo "[1/5] Verificando e instalando Nginx e Certbot SSL..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx

# 2. Geração da configuração Nginx otimizada para Streaming HLS/MPEG-TS
echo "[2/5] Gerando configuração de Proxy Reverso para $DOMAIN..."
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"

cat > "$NGINX_CONF" << EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Otimizações críticas de baixa latência para IPTV e VOD
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

# 3. Criação de symlink e teste do Nginx
echo "[3/5] Habilitando site e testando sintaxe do Nginx..."
ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t

echo "[4/5] Recarregando Nginx..."
systemctl reload nginx

# 4. Geração do Certificado SSL Let's Encrypt Não-Interativo
echo "[5/5] Solicitando e configurando Certificado SSL Let's Encrypt para $DOMAIN..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || {
    echo "⚠️ Certbot avisou que a emissão SSL falhou (verifique se o DNS Registro A aponta para o IP da VPS)."
    echo "O Nginx continuará ativo e respondendo via HTTP porta 80."
}

systemctl reload nginx

echo "=========================================================="
echo " ✅ INFRAESTRUTURA CONFIGURADA COM SUCESSO!"
echo " 🔒 URL Segura: https://$DOMAIN"
echo " 🍿 Player e Painel ADM disponíveis com proxy reverso ativo!"
echo "=========================================================="
exit 0

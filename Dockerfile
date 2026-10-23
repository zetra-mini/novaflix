# ==============================================================================
# Multi-Stage Build Otimizado para Produção (~150MB)
# ==============================================================================

# Estágio 1: Dependências e Compilação
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++ tzdata

COPY package*.json ./

RUN npm ci --omit=dev

# Estágio 2: Imagem Final Leve para Produção
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache tzdata ca-certificates

ENV NODE_ENV=production
ENV PORT=3000

# Copia apenas as dependências essenciais já compiladas do estágio anterior
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copia o código da aplicação
COPY server.js ./
COPY admin-manager.js ./
COPY playlist-manager.js ./
COPY epg-manager.js ./
COPY services/ ./services/
COPY controllers/ ./controllers/
COPY routes/ ./routes/
COPY scripts/ ./scripts/
COPY data/ ./data/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "server.js"]

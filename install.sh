#!/usr/bin/env bash
# =============================================================================
# ML Dashboard — Script de Instalação
# Uso: bash install.sh
# Testado em: Ubuntu 22.04 / Debian 12
# =============================================================================
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()    { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $*"; }
error()   { echo -e "${RED}[✗]${RESET} $*"; exit 1; }
section() { echo -e "\n${BOLD}═══ $* ═══${RESET}"; }

# ── 0. Pré-requisitos ──────────────────────────────────────────────────────
section "Verificando pré-requisitos"

command -v node  >/dev/null 2>&1 || error "Node.js não encontrado. Instale: https://nodejs.org (v18+)"
command -v npm   >/dev/null 2>&1 || error "npm não encontrado"
command -v psql  >/dev/null 2>&1 || error "PostgreSQL client não encontrado. Instale: apt install postgresql-client"
command -v redis-cli >/dev/null 2>&1 || warn "redis-cli não encontrado (opcional para testes)"

NODE_VERSION=$(node -e "process.stdout.write(process.version.replace('v','').split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js v18+ é obrigatório. Versão atual: $(node -v)"
fi

info "Node.js $(node -v) ✓"
info "npm $(npm -v) ✓"

# ── 1. Dependências do servidor ────────────────────────────────────────────
section "Instalando dependências"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"

if [ ! -d "$SERVER_DIR" ]; then
  error "Diretório server/ não encontrado. Execute a partir da raiz do projeto."
fi

cd "$SERVER_DIR"
npm install
info "Dependências instaladas"

# ── 2. Arquivo .env ────────────────────────────────────────────────────────
section "Configuração de ambiente"

if [ ! -f "$SERVER_DIR/.env" ]; then
  cp "$SERVER_DIR/.env.example" "$SERVER_DIR/.env"
  warn ".env criado a partir do .env.example"
  warn "EDITE o arquivo server/.env antes de continuar:"
  warn "  DATABASE_URL, REDIS_URL, ML_CLIENT_ID, ML_CLIENT_SECRET"
  echo ""
  echo -e "  ${YELLOW}nano $SERVER_DIR/.env${RESET}"
  echo ""
  read -r -p "Pressione ENTER após editar o .env (ou Ctrl+C para cancelar)..."
else
  info ".env já existe — não sobrescrito"
fi

# ── 3. Carregar variáveis ──────────────────────────────────────────────────
set -a
# shellcheck disable=SC1091
source "$SERVER_DIR/.env"
set +a

DATABASE_URL="${DATABASE_URL:-}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"

if [ -z "$DATABASE_URL" ]; then
  error "DATABASE_URL não definida no .env"
fi

# ── 4. Banco de dados ──────────────────────────────────────────────────────
section "Configurando PostgreSQL"

# Extrai host/porta/db/user/pass da DATABASE_URL
# Formato esperado: postgres://user:pass@host:port/dbname
DB_USER=$(echo "$DATABASE_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')
DB_PASS=$(echo "$DATABASE_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
DB_PORT=$(echo "$DATABASE_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
DB_NAME=$(echo "$DATABASE_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')

DB_PORT="${DB_PORT:-5432}"

info "Conectando em $DB_HOST:$DB_PORT/$DB_NAME como $DB_USER"

# Testa conexão
if ! PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "SELECT 1" > /dev/null 2>&1; then
  error "Não foi possível conectar ao PostgreSQL. Verifique DATABASE_URL e se o servidor está rodando."
fi

# Cria banco se não existir
DB_EXISTS=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
  -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null || echo "")

if [ -z "$DB_EXISTS" ]; then
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
    -c "CREATE DATABASE $DB_NAME" > /dev/null
  info "Banco de dados '$DB_NAME' criado"
else
  info "Banco de dados '$DB_NAME' já existe"
fi

# Executa migração
cd "$SERVER_DIR"
node src/db/migrate.js
info "Schema aplicado com sucesso"

# ── 5. Redis ───────────────────────────────────────────────────────────────
section "Verificando Redis"

REDIS_HOST=$(echo "$REDIS_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')
REDIS_PORT=$(echo "$REDIS_URL" | sed -n 's|.*:\([0-9]*\)$|\1|p')
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

if command -v redis-cli >/dev/null 2>&1; then
  if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null 2>&1; then
    info "Redis em $REDIS_HOST:$REDIS_PORT respondendo"
  else
    warn "Redis não está respondendo em $REDIS_HOST:$REDIS_PORT"
    warn "Inicie com: sudo systemctl start redis  (ou: redis-server --daemonize yes)"
  fi
else
  warn "redis-cli não instalado — verifique manualmente se o Redis está rodando"
fi

# ── 6. Jobs de Schedule (opcional) ────────────────────────────────────────
section "Registrando jobs de schedule"

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1 << 'SQL'
INSERT INTO schedule_jobs (name, cron, status) VALUES
  ('refresh_token',    '0 */5 * * *',   'idle'),
  ('sync_inventory',   '0 */2 * * *',   'idle'),
  ('sync_visits',      '0 2 * * *',     'idle'),
  ('sync_performance', '0 3 * * *',     'idle'),
  ('sync_items',       '0 4 * * *',     'idle')
ON CONFLICT (name) DO NOTHING;
SQL
info "Jobs de schedule registrados"

# ── 7. Resumo ──────────────────────────────────────────────────────────────
section "Instalação concluída"

cat << EOF

${BOLD}Para iniciar o sistema:${RESET}

  ${GREEN}# Terminal 1 — Servidor HTTP + WebSocket${RESET}
  cd server && npm start

  ${GREEN}# Terminal 2 — Worker BullMQ (processa webhooks)${RESET}
  cd server && npm run worker

${BOLD}URLs:${RESET}
  Dashboard:   http://localhost:${PORT:-3000}/../index.html  (abra o index.html no browser)
  REST API:    http://localhost:${PORT:-3000}/api
  WebSocket:   ws://localhost:${PORT:-3000}/ws
  Webhook ML:  http://localhost:${PORT:-3000}/webhooks/ml
  Health:      http://localhost:${PORT:-3000}/health

${BOLD}Próximos passos:${RESET}
  1. Configure o Webhook no painel do Mercado Livre apontando para /webhooks/ml
  2. Cadastre sua loja na tabela stores (veja README.md)
  3. Exponha a porta com ngrok para testes locais: ngrok http 3000

EOF

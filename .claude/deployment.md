# Deployment

> Escopo: como o sistema roda em produção — servidor, processos, banco, proxy. Ambiente de desenvolvimento local está em `backend.md` (variáveis de ambiente) e no `server/README.md`. **Sempre que a topologia de produção mudar (novo domínio, novo serviço, nova migration aplicada manualmente), atualize este arquivo.**

## Branch principal do repositório

**O branch padrão (principal) no GitHub é `claude/archive-files-git-8vn8pv`** — este repositório não tem `main` nem `master`. Qualquer trabalho que precise "ir para o branch principal" deve ser mesclado/enviado para `claude/archive-files-git-8vn8pv`. Branches de sessão do Claude Code (`claude/<nome-da-sessão>`) são criados a partir dele e devem ser mesclados de volta nele quando o trabalho estiver pronto para ficar permanente — não presumir que existe um branch `main` a criar.

## Produção

- **URL pública**: `https://multimixvendas.duckdns.org`
- **Diretório**: `/opt/ml-dashboard-novo`
- **`.env`**: `/opt/ml-dashboard-novo/server/.env` (**não** na raiz do repositório)
- **Processos** (dois serviços systemd, ver `architecture.md` para a divisão de responsabilidade):
  - `ml-dashboard-novo` — servidor Express (`npm start`)
  - `ml-worker-novo` — worker BullMQ (`npm run worker`)

```bash
# Deploy
cd /opt/ml-dashboard-novo && git pull
systemctl restart ml-dashboard-novo ml-worker-novo

# Logs em tempo real
journalctl -u ml-dashboard-novo -f
journalctl -u ml-worker-novo -f

# Migration (sempre a partir de server/, nunca da raiz)
cd /opt/ml-dashboard-novo/server && node src/db/migrate.js
```

## PostgreSQL

- Banco: `ml_dashboard`, dono `postgres`.
- Usuário da aplicação: `ml_user` (senha em `.env`). Outros roles existentes: `mladmin`, `monitor`.
- **Erro comum**: `migrate.js` falha com `must be owner` se alguma tabela foi criada por outro role. Correção:
```bash
sudo -u postgres psql -d ml_dashboard -c "SELECT 'ALTER TABLE '||tablename||' OWNER TO ml_user;' FROM pg_tables WHERE schemaname='public';" -t | sudo -u postgres psql -d ml_dashboard
```

## Redis

`redis://localhost:6379` (mesma instância para cache, pub/sub e filas BullMQ — ver `redis.md`/`workers.md`).

## Armazenamento local — vídeos de Embalagem

`server/storage/embalagem-videos/` (fora do git, criado automaticamente) guarda os vídeos de conferência de embalagem, retenção de 30 dias (job `cleanupPackingVideos`, ver `workers.md`/`embalagem.md`). É o único lugar do sistema hoje que grava arquivo binário em disco fora do Postgres/Redis — monitorar espaço em disco da VPS se o volume de embalagens crescer muito (`df -h` no diagnóstico rápido abaixo já cobre isso de forma geral).

**Requisito de nginx — `client_max_body_size`**: o nginx tem limite padrão de **1MB** por corpo de requisição. Um vídeo gravado pelo `MediaRecorder` (mesmo poucos segundos) já ultrapassa isso, e o upload trava na tela sem erro claro (nginx rejeita a conexão antes de completar, o `fetch()` do navegador fica esperando uma resposta que não vem do jeito certo). É **obrigatório** adicionar, dentro do `server {}` (ou específico do `location /api/embalagem`), no mesmo arquivo de config nginx já usado pra WebSocket:
```nginx
client_max_body_size 300m;
```
(300MB casa com o limite configurado no `multer` de `routes/embalagem.js` — é só uma trava de segurança, uma gravação de conferência normal fica bem abaixo disso.) Depois de editar, `sudo nginx -t && sudo systemctl reload nginx`.

## Nginx — WebSocket

Sem os headers de upgrade e timeouts corretos, o nginx derruba conexões WS ociosas em 60s. Config de referência versionada em `server/nginx-websocket.conf` (aplicar dentro do `location /ws` do server block):

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;
}
```

O `server.js` também ajusta `keepAliveTimeout`/`headersTimeout` para 1h do lado Node (ver `backend.md`), como segunda camada de proteção contra timeout no SSE de logs (`/api/schedule/worker-logs`) e no WS.

## Lojas conectadas (referência operacional)

| Loja | ID ML | Imposto % |
|---|---|---|
| RICOPI_MULTIMERCADO | 1230372619 | 7,5% |
| TOP_MIX_ | 1832985010 | 8,71% |
| UNIFULL_MULTIMERCADO | 1662123376 | 4% |

## Webhook do Mercado Livre

Callback configurada no painel do app ML: `https://multimixvendas.duckdns.org/webhooks/ml`. Redirect URI OAuth: `https://multimixvendas.duckdns.org/auth/callback` (também aceita `/ml/callback`, ver `mercadolivre.md`).

## Transição do sistema antigo

Existe (ou existiu) um serviço legado `ml-dashboard.service` (`/src/server.js` do repositório `servidorlinux`), que era a fonte de dados real antes desta reescrita EDA. Ele só deve ser desativado depois de confirmado:
1. Webhook do ML apontando para `/webhooks/ml` deste backend (não mais para o serviço antigo).
2. `webhook_logs.status = 'processed'` consistentemente (worker estável, sem acúmulo de `failed`/`pending`).
3. Páginas do dashboard novo exibindo dados reais vindos do Postgres (não mais mockados/do sistema antigo).

Ver `roadmap.md` para o status atual dessa migração.

## Diagnóstico rápido

```bash
# Webhooks recebidos recentemente
sudo -u postgres psql -d ml_dashboard -c "SELECT topic, status, created_at FROM webhook_logs ORDER BY received_at DESC LIMIT 20;"

# Status de token por loja
sudo -u postgres psql -d ml_dashboard -c "SELECT nickname, token_expires_at, CASE WHEN token_expires_at > now() THEN 'OK' ELSE 'EXPIRADO' END FROM stores;"

# Forçar sync diário via Redis (ou usar server/sync-now.sh)
redis-cli PUBLISH worker:cmd '{"cmd":"dailySync"}'

# Diagnóstico OAuth
curl https://multimixvendas.duckdns.org/auth/config
```

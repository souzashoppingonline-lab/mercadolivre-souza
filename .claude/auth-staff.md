# Login de acesso restrito (staff)

Sistema de autenticação para funcionários que só precisam da página de Embalagem (bipar etiqueta + gravar vídeo de conferência), sem acesso ao resto do dashboard (relatórios de vendas, financeiro, etc.). Não é o mesmo tipo de "auth" que `routes/auth.js`/`routes/shopeeAuth.js` — aquelas são OAuth de conta de vendedor (ML/Shopee), isto é login de usuário interno.

## Contexto e decisão

Pedido original do usuário: dar acesso de Embalagem a funcionários sem expor o resto do sistema (relatórios de vendas etc.), "sem mexer em nada porque está tudo perfeito e funcionando". Duas abordagens foram avaliadas:

1. **Leve** — só proteger a rota/página de Embalagem via um gate simples (ex. nginx basic auth só nesse path).
2. **Completo** — login por usuário com papel (`admin`/`embalagem`), aplicado a todo o sistema.

O usuário escolheu a opção completa, explicitamente ciente do trade-off ("mexe na forma como o sistema é acessado hoje"): uma proteção parcial não impede um funcionário de navegar direto pra qualquer outra página por URL — só um gate que cobre **tudo**, inclusive o próprio dono do sistema, restringe de verdade. Ver `decisions.md`.

## Kill switch — proteção contra travar o próprio acesso

`STAFF_AUTH_ENABLED` (`server/.env`, default `false`) liga/desliga o gate inteiro. Enquanto `false`, `requireStaffAuth` é um no-op — o sistema funciona exatamente como sempre funcionou, sem exigir login de ninguém. Isso existe pra permitir configurar tudo (migration, dependências, criar o 1º usuário) com o sistema já rodando em produção, e só then virar a chave. Se algo travar o acesso depois de ligado, `STAFF_AUTH_ENABLED=false` + restart do `ml-dashboard-novo` desliga a autenticação na hora, sem reverter nenhum deploy.

## Schema — `staff_users` (migration v22)

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | SERIAL PK | |
| `username` | TEXT UNIQUE NOT NULL | |
| `password_hash` | TEXT NOT NULL | bcrypt, custo 10 |
| `role` | TEXT NOT NULL DEFAULT 'admin' | `admin` (acesso total) ou `embalagem` (só Embalagem) |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

Sem UI de gerenciamento de usuários — criar/atualizar usuário é via script (seção abaixo).

## Sessão — JWT em cookie httpOnly

`POST /auth/staff/login` (`server/src/routes/staffAuth.js`) valida usuário/senha (bcrypt), assina um JWT (`STAFF_JWT_SECRET`, payload `{sub, username, role}`) com validade `STAFF_SESSION_DAYS` (default 180 dias — sessão longa de propósito, pedido explícito do usuário pra não precisar logar toda hora, inclusive o admin). Grava em cookie `staff_session` (`httpOnly`, `secure`, `sameSite=lax`).

`POST /auth/staff/logout` limpa o cookie. `GET /auth/staff/me` devolve `{username, role}` da sessão atual (401 se não autenticado) — usado por `js/layout.js` pra personalizar a sidebar/topbar sem forçar redirect quando não há sessão (ver "Frontend" abaixo).

## Middleware `requireStaffAuth` — o que cada papel pode acessar

Montado globalmente em `server.js`, **antes** de todas as outras rotas (inclusive antes de `express.static`), então cobre tanto `/api/*` quanto o carregamento de página.

- **Sempre público** (mesmo com o gate ligado): `/webhooks/*` (ML), `/auth/*` e `/ml/*` (OAuth ML/Shopee), `/health`, `/ws` (WebSocket), `/pages/login.html`, `/favicon.ico`. Nenhum desses é iniciado por uma sessão de staff logada.
- **Sem sessão válida**: `/api/*` devolve `401`; qualquer outra rota redireciona para `/pages/login.html`.
- **Papel `admin`**: acesso irrestrito, igual ao sistema sempre foi.
- **Papel `embalagem`**: só passa se o caminho for `/api/embalagem/*`, `/api/lojas` (dropdown de loja na aba Conferência do Dia), `/pages/embalagem.html`, ou um asset estático (`/css/`, `/js/`, `/favicon`). Qualquer outro caminho: `403` em API, redirect para `/pages/embalagem.html` em página.

## Frontend

- **`pages/login.html`** — autocontido (CSS inline, sem dependência de `css/style.css` nem CDN), pra funcionar mesmo se o resto do estático não estiver acessível. Formulário simples (usuário/senha) → `POST /auth/staff/login` → redireciona por papel (`embalagem` → `embalagem.html`, senão → `../index.html`). Se `GET /auth/staff/me` já resolver ao carregar, redireciona sem mostrar o formulário.
- **`js/layout.js`** — no `DOMContentLoaded`, busca `GET /auth/staff/me` (falha silenciosamente pra `null` se não houver sessão ou o gate estiver desligado — **nunca força redirect no cliente**, a proteção real é 100% server-side em `requireStaffAuth`). Se `role === 'embalagem'`: `navItemsForRole()` reduz a sidebar a só o item Embalagem, e o switcher de marketplace (Amazon/Shopee) some do topbar. Se houver sessão (qualquer papel), mostra usuário + botão "Sair" no topbar (`POST /auth/staff/logout` → redireciona pro login).

## Criar/atualizar usuário — `server/scripts/createStaffUser.js`

```bash
cd server
node scripts/createStaffUser.js <username> <senha> [admin|embalagem]
```

`role` default `admin`. Rodar de novo com o mesmo `username` atualiza senha (e papel, se informado) — não cria duplicata (`ON CONFLICT (username) DO UPDATE`).

## Infraestrutura — mudança obrigatória no nginx

Antes desta feature, `pages/*.html`/`css/*`/`js/*` eram servidos **direto pelo nginx** (`root /opt/ml-dashboard-novo; try_files $uri $uri/ /index.html;`), nunca passavam pelo Node — um gate só em Express não protegeria o carregamento de página, só chamadas `/api`. Passou a ser necessário:

1. `server.js` ganhou `express.static(<raiz do repo>)` + fallback SPA (`app.get('*', ...)` → `index.html`, exceto para `/api`, `/webhooks`, `/auth`, `/ml`, `/ws`, `/health`, que continuam com suas próprias rotas).
2. **nginx** precisa trocar o `location /` de servir arquivo direto para `proxy_pass http://127.0.0.1:3000;` (mesmo padrão que `/api`/`/webhooks` já usam). Ver `deployment.md` para o procedimento exato e o rollback.

Enquanto o nginx não for atualizado, o `express.static` novo fica sem efeito (nginx continua respondendo primeiro) — ou seja, é seguro fazer o deploy do código antes de mexer no nginx, mas a proteção de página só vale de verdade depois dos dois passos.

## Fora de escopo (deliberado)

- UI de gerenciamento de usuários (criar/listar/desativar) — só o script `createStaffUser.js`.
- Recuperação de senha — sessão de 180 dias reduz a necessidade; se esquecer, roda o script de novo.
- Rate limiting / lockout de tentativas de login — volume de usuários é baixo (poucos funcionários), risco aceito por ora.
- Notificação de login suspeito.

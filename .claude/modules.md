# Módulos do Sistema

> Escopo: a organização do sistema em **módulos** — cada um com seu próprio menu lateral, como se fosse um sistema separado. Troca-se de módulo pelo **switcher no topbar** (`.module-switcher`). Para o frontend estático em si ver `frontend.md`; para os marketplaces (que são "sub-sistemas" dentro do Operacional) ver `frontend.md`/`shopee.md`/`amazon.md`.

## Os 3 módulos

| Módulo | O que é | Menu lateral | Fonte de dados |
|---|---|---|---|
| **Operacional** | O sistema atual completo (ML + Amazon + Shopee, rankeamento, embalagem, conciliação, etc.) | `js/layout.js` (`NAV_ITEMS`) — e os layouts próprios de Amazon/Shopee dentro dele | Postgres principal (`db/pool.js`) |
| **Financeiro** | Controle financeiro (em construção) | `js/layout-financeiro.js` (`FIN_NAV_ITEMS`) | **Supabase separado** (banco já existente de outra ferramenta — ver abaixo) |
| **Inteligência de Negócio** | Análises estratégicas (em construção) | `js/layout-bi.js` (`BI_NAV_ITEMS`) | a definir |

Hoje **Financeiro** e **Inteligência de Negócio** têm só a página "em construção" (`pages/financeiro.html`, `pages/inteligencia-negocio.html`). O Operacional está 100% pronto.

## Como funciona a troca de módulo

- Cada módulo tem seu **layout próprio** (sidebar + topbar), mesmo padrão de `js/layout-amazon.js`/`js/layout-shopee.js`: a página tem `<div id="app-sidebar">`/`<div id="app-topbar">` e o layout injeta o menu no `DOMContentLoaded`.
- O **switcher de módulos** (`buildModuleSwitcher`, classe CSS `.module-switcher`) fica no `topbar-left` e leva a `../index.html` (Operacional), `financeiro.html` e `inteligencia-negocio.html`. Está replicado em `layout.js`, `layout-financeiro.js` e `layout-bi.js` (mesmo motivo do switcher de marketplace ser replicado — cada layout monta seu próprio topbar) e também inline no `index.html` (topbar da raiz).
## Autorização de módulos (implementado)

Fonte de verdade: o objeto **`MODULES`** em `server/src/routes/staffAuth.js` — mapeia cada módulo para os papéis que podem acessá-lo, mais as `pages`/`apiPrefixes` que pertencem a ele:

```js
const MODULES = {
  operacional: { roles: '*' },                          // todos os papéis logados
  financeiro:  { roles: ['admin'], pages: ['/pages/financeiro.html'], apiPrefixes: ['/api/financeiro'] },
  bi:          { roles: ['admin'], pages: ['/pages/inteligencia-negocio.html'], apiPrefixes: ['/api/bi'] },
};
```

Hoje **Financeiro e Inteligência de Negócio são só `admin`**. Para autorizar um papel novo, mudar quem vê um módulo, ou adicionar um módulo, **edita-se só esse objeto** — nada mais.

Como é aplicado:
- **Backend (gate real)**: `requireStaffAuth` chama `restrictedModuleForPath(path)`; se o path é de um módulo restrito e o papel não está autorizado, bloqueia (`403` em API) ou redireciona pra `/` (página). Vale pra qualquer papel.
- **Frontend (UX)**: `GET /auth/staff/me` devolve `modules: [...]` (chaves autorizadas). `applyModuleAuth()` em `js/layout.js` **remove do switcher** os botões de módulo não autorizados (inclui o switcher inline do `index.html`, via `data-module`). Se o gate estiver desligado (`modules` ausente), não esconde nada.

Papéis restritos legados (`embalagem`, `shopee-demo`) continuam com suas próprias regras (redirecionados antes de chegar ao gate de módulo).

## Módulo Financeiro — banco Supabase (implementado, READ-ONLY)

O Financeiro lê de um **Supabase existente** (projeto "Sistema de Gestão Financeira E-commerce", dados reais de outra ferramenta — **nada pode ser perdido**). Como está feito:

- **Cliente isolado** `server/src/db/supabaseFin.js` — REST (PostgREST `/rest/v1`), **só GET** (lista tabelas, prévia de linhas). **Não existe escrita/update/delete** no código. Distinto do `db/pool.js`; `migrate.js` **nunca** aponta pra cá.
- **Config** em `env.financeiro` (`SUPABASE_FIN_URL` + `SUPABASE_FIN_KEY`, do `.env` do servidor). Sem elas o módulo responde "não configurado". A chave pode ser `anon` (respeita RLS) ou `service_role` (ignora RLS — só no servidor).
- **Rotas** `/api/financeiro/*` (montadas em `server.js`, **só admin** via MODULES): `GET /status` (configurado/conectado), `GET /tabelas` (lista), `GET /tabela/:nome?limit` (prévia read-only, ≤200, nome sanitizado). Métodos espelho em `js/db.js` (`getFinanceiroStatus/Tabelas/Tabela`).
- **Página** `pages/financeiro.html` = **explorador**: mostra status da conexão, lista as tabelas do Supabase e a prévia de cada uma. Serve pra descobrir o schema real (o ambiente de dev não tem egress pro Supabase, então a validação acontece no deploy).
- **Rede**: o servidor de produção precisa de egress pro Supabase (443 REST). Os dois bancos **não se juntam em SQL** — cruzamento ML×Financeiro é na aplicação.

Próximo passo (quando virmos as tabelas reais): transformar o explorador nas telas financeiras de verdade (continua read-only até o usuário pedir escrita).

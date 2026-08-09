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
- **Permissão**: o gate de `routes/staffAuth.js` já libera todas as páginas para `admin`; papéis restritos (`embalagem`, `shopee-demo`) continuam barrados e redirecionados. Quando o Financeiro for pra valer, dá pra criar um papel `financeiro`.

## Módulo Financeiro — banco Supabase (planejado, ainda NÃO implementado)

O Financeiro vai ler de um **Supabase existente** (Postgres hospedado, com dados reais de outra ferramenta — **nada pode ser perdido**). Decisão de arquitetura (a implementar quando as credenciais/esquema chegarem):

1. **Pool separado e isolado** no backend (`server/src/db/supabasePool.js`), distinto de `db/pool.js`. Rotas `/api/financeiro/*` leem/escrevem só nesse pool; as páginas chamam via `js/db.js` (mantém a regra "frontend nunca fala com banco externo direto").
2. **`db/migrate.js` NUNCA aponta pro Supabase** — sem rodar `schema.sql`/migrations lá, o esquema deles fica intacto. Começar **read-only**; escrever só o que for autorizado.
3. Os dois bancos **não se juntam em SQL** — qualquer cruzamento ML×Financeiro é feito na aplicação.
4. Segredos (URL/senha/anon key) no `.env` do servidor, nunca no frontend. Liberar egress do servidor de produção → Supabase.

Registrar essa decisão em `decisions.md` quando implementar.

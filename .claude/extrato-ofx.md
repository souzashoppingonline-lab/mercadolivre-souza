# Extrato Bancário (OFX)

Página **Financeiro → Extrato Bancário (OFX)** (`pages/financeiro-extrato-ofx.html`, v144 — prévia aprovada pelo usuário). Importa o extrato do banco em OFX, classifica entradas/saídas por categoria, mostra saldo dia a dia, alertas, recorrentes, **mês a mês** (resumo salvo) e uma análise da IA que só interpreta os números.

## Fluxo

```
arquivo .ofx ──POST /importar (multer, memória, ≤ 10 MB, ≤ 12 arquivos)──▶ ofx.js lerOfx()
   ──▶ por conta do arquivo: upsert ofx_contas, insere ofx_importacoes
   ──▶ cada lançamento: ofxCategorias.classificar() (regra aprendida > palavra-chave > sem_categoria)
   ──▶ INSERT … ON CONFLICT (conta_id, chave) DO NOTHING   (mesmo período 2× = ignorado)
   ──▶ salvarResumosMensais() regrava ofx_resumos_mensais (todos os meses)
tela ──GET /resumo──▶ ofxAnalise.resumoMes() (números)   ──POST /analise-ia──▶ IA interpreta o resumo
```

## Arquivos

| Arquivo | O quê |
|---|---|
| `server/src/ofx.js` | Leitor PURO. OFX 1.x (SGML, tags sem fechamento, `CHARSET:1252` → latin1) e 2.x (XML). Leitura por tag (`<TAG>valor` até o próximo `<`). Valor aceita `-1234.56`, `-1234,56`, `-1.234,56`. Vários `<STMTRS>`/`<CCSTMTRS>` por arquivo. |
| `server/src/ofxCategorias.js` | `CATEGORIAS` (id, sentido entrada/saida/ambos, ícone, `fora` do total), `contraparte()` (tira "Pix Enviado/Recebido", "Pagamento De Boleto (Outros Bancos)", data/hora e a repetição que o Santander cola no fim; CNPJ/CPF formatados) e `classificar()`. |
| `server/src/ofxAnalise.js` | `resumoMes()` PURO: totais (sem as categorias `fora`), por categoria, tarifas, saldo dia a dia, destinatários/origens, recorrentes, alertas. |
| `server/src/routes/extratoOfx.js` | Rotas (`/api/financeiro/extrato-ofx`, ver `api.md`), `salvarResumosMensais()`, montagem do texto da IA (`paraIa`). |
| `server/test/ofx.test.js` | 10 testes (dados inventados — nunca o extrato real do usuário). |

## Regras

- **Anti-duplicado** = `sha1(data|valor|descrição normalizada|nº da ocorrência no arquivo)`, não o FITID: o FITID do Santander traz a data/hora da exportação e muda a cada export do mesmo período (visto no arquivo real de set/2026). Dois lançamentos idênticos no mesmo dia continuam distintos pelo nº da ocorrência.
- **Saldo**: `<LEDGERBAL><BALAMT>` = saldo no **fim do período do arquivo** (`DTEND`). O Santander põe em `<DTASOF>` a hora da exportação (01/11), mas o valor é o de 30/09 — conferido com o "Caixa Dia 1" de out/2026 digitado pelo usuário (R$ 22.239,10 × BALAMT R$ 22.239,61). Saldo de cada dia = saldo de referência (importação com maior `dt_fim` da conta) − lançamentos depois do dia. Extrato que termina no meio do mês → dias seguintes sem saldo. "Todas as contas" só soma saldo se todas têm referência até o fim do mês.
- **Categorias `fora` do total**: `entre_contas` (PIX/TED pra banco/carteira digital, "mesma titularidade") e `investimento` (aplicação/resgate) — não são receita nem despesa. PIX pra banco/carteira entra como `entre_contas` com origem `auto` e gera alerta "confira".
- **Aprender**: corrigir a categoria de um lançamento grava `ofx_regras[contraparte_chave]` e reclassifica os outros da mesma contraparte (mesmo sentido; os marcados à mão ficam). ✏️ dá um nome amigável (apelido) à contraparte — útil pro "Pix Recebido <CNPJ>". Origem na tela: `auto` / `aprendido` / `você`.
- **Alertas**: possível pagamento em dobro (mesma data + valor + contraparte, saída); saldo < R$ 5.000 (`SALDO_BAIXO`); fora do padrão (saída > 3× a mediana dos 3 meses anteriores da mesma contraparte, com ≥ 3 ocorrências — **1 alerta por contraparte**, com a quantidade e o maior valor); "entre contas" automático a confirmar; sem categoria.
- **Recorrentes**: mesma contraparte de saída em ≥ 3 dos últimos 4 meses (dia = mediana, valor médio).
- **Mês a mês** (`ofx_resumos_mensais`, pedido do usuário): entradas, saídas, resultado, saldo inicial/final/menor, tarifas, nº de lançamentos, sem categoria e totais por categoria de cada mês, por conta e "todas" (`conta_id 0`). Regravado depois de cada importação (todos os meses — saldo antigo muda quando chega extrato mais novo) e de cada correção de categoria (meses da contraparte). Botão "↻ Recalcular" regrava tudo. **v145 (prévia aprovada pelo usuário)**: na tela, **um card por mês** (mais novo primeiro; cor própria por mês do ano — `COR_MES`; resultado, entradas/saídas com ▲▼, saldo no fim, nº de alertas e de "sem categoria") — clique abre o **modal do mês** (KPIs, IA salva, categorias, alertas, para quem mais foi, 10 maiores saídas e entradas; botão "Abrir este mês na página"; fecha com ✕/ESC/clique fora). A tabela comparativa virou "📊 Ver comparativo em tabela". Coluna `alertas` (v128) = alertas que pedem atenção (dobro, saldo baixo, fora do padrão). **v146 (prévia aprovada pelo usuário)**: no modal do mês, a categoria de cada lançamento (maiores saídas/entradas) é um botão ✎ que abre a janela **Escolher categoria** (só as do sentido do lançamento; "Aplicar a todos de <contraparte>" marcado por padrão = mesma regra aprendida do PATCH); salva e recarrega o modal e a página. **v147 (prévia aprovada pelo usuário)** — **mês de competência** (`ofx_lancamentos.mes_competencia`, v129): conta paga no fim do mês que o banco só compensou no 1º dia útil seguinte (ex.: sáb 31/10 → seg 03/11, com dom 01/11 e feriado 02/11) pode contar no mês anterior. Totais, categorias, alertas, comparações, recorrentes, cards e `ofx_resumos_mensais` agrupam por `COALESCE(mes_competencia, mês da data)`; o **saldo dia a dia continua pela data do banco** (é o saldo real). Na lista de lançamentos: ☑ por linha + barra "📆 Contar em <mês anterior>" / "↩ Voltar pro mês do banco"; aviso automático quando o 1º movimento do mês é entre os dias 2 e 5 (filtra os lançamentos daquele dia pra escolher); etiqueta "📆 compensou em nov." no mês que recebeu. `PATCH /competencia` só aceita ±1 mês da data do banco. **v148 (prévia aprovada pelo usuário)** — botão **🗑️ Apagar importação** (pra reenviar): tudo / só uma conta / só um mês (pela data do banco; apaga também as importações cujo `dt_fim` cai nesse mês, porque o saldo delas é desse mês); prévia do que some (`GET /dados/previa`), aviso de que não volta, botão só libera digitando **APAGAR** (o servidor também exige `confirmacao=APAGAR`); "manter categorias e nomes que ensinei" marcado por padrão (`ofx_regras` fica → reenviar já volta classificado). Depois apaga `ofx_resumos_mensais` inteiro e regrava os meses que sobraram; loga quem apagou. **v149 (prévia — aguardando aprovação)** — **arquivo que atravessa o mês**, automático (pedido do usuário: o extrato de outubro do Santander vinha até seg 03/11): `competenciaDoArquivo()` — se o arquivo começa no mês M e termina até o dia 5 de M+1, os lançamentos de M+1 do arquivo já entram com `mes_competencia = M` (status da importação avisa). Reimportar o mesmo arquivo preenche `mes_competencia` só onde está vazio (nunca desfaz escolha manual). `migrate-v130` faz o mesmo nos dados já importados, **uma vez** (marca `app_config.ofx_v130_competencia`), e limpa o mês a mês (`GET /mensal` regrava sozinho quando vazio). Na tela: o aviso do 1º dia útil ganhou **"📆 Contar tudo de 01 a DD/MM em <mês anterior>"** (um clique) e o aviso do mês que recebeu ganhou **"↩ Desfazer"** (desfazer + reimportar o mesmo arquivo move de novo — é a regra automática). `salvarResumosMensais()` sem filtro agora também apaga mês/conta que ficou sem lançamento.
- **IA** (`ai/llm.js`, feature `extrato_ofx`): recebe só o resumo já calculado + nomes de contraparte — nunca nº de conta/agência. Devolve `{pontos[], recomendacoes[]}`, salvo em `ofx_analises_ia` (último por mês/conta). Sem `ANTHROPIC_API_KEY` o botão fica desligado.

## Bancos testados

- Santander (OFX 1.x SGML, valor com vírgula, descrição só em `<MEMO>`) — arquivo real de set/2026.
- XML 2.x genérico (teste sintético). Outros bancos: confirmar com arquivo real quando o usuário importar.

## Fase 2 (não feita, cogitada)

Conferir o extrato com o sistema: repasses do Mercado Pago × `mp_account_movements`, boletos pagos × Boletos (Supabase).

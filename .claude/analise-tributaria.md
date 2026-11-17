# Análise Tributária — "seu contador sênior" (Financeiro)

> Pedido do usuário (16/11/2026): página no módulo Financeiro que analisa as empresas de quem ele compra (gera crédito de ICMS?), mostra em que estados vende (nº e %), recebe XMLs de venda e avalia se vale sair do Simples Nacional para o Lucro Real. "Essa página seria meu contador sênior." Fase 1 implementada na v186; fases 2–4 planejadas (abaixo).

## Situação das empresas (informada pelo usuário em 16/11/2026)

- **Todas em São Paulo, todas no Simples Nacional** (comércio → Anexo I).
- CNPJs no Supabase `stores`: UNIFULL = MULTIMIX VENDAS ONLINE `53727812000108`; R SOUZA = R SOUZA VENDAS ONLINE `48126073000150`; TOP MIX sem CNPJ cadastrado. Lojas de canal (SHOPEE, TIKTOK SHOP UNIFULL, AMAZON RSOUZA, SHOPEE R SOUZA) são canais de alguma dessas empresas.
- **XMLs de venda** saem do **emissor do Mercado Livre** e do **UpSeller** (ERP).
- **Folha**: funcionários sem registro — usar os **valores transferidos** a eles (não há folha formal). No Simples (Anexo I) o INSS patronal (CPP) está dentro do DAS; no Presumido/Real é à parte (~20%+ sobre folha) e só deduz se a folha for formal — o simulador (fase 3) mostra os dois cenários.
- Estimativa de 16/11 (Vendas & Custos, 10/07–08/11, projetado p/ 12 meses): UNIFULL ~R$ 1,95 mi/ano (5ª faixa), R SOUZA ~R$ 850 mil, TOP MIX ~R$ 500 mil, SHOPEE ~R$ 74 mil. **Se os sócios forem os mesmos, a LC 123 soma o faturamento das empresas pros limites** (~R$ 3,4 mi juntas, perto do sublimite de R$ 3,6 mi) — ponto levado ao usuário pra confirmar com o contador.

## Regras tributárias usadas (resumo — fonte única em `server/src/tributario.js`)

- **Crédito de ICMS só existe se a SUA empresa estiver no regime normal** (Lucro Presumido ou Real). No Simples não há crédito — a página mostra o "crédito que você teria" no regime normal.
- **Do lado do fornecedor**, o que importa é o `CRT` do emitente no XML: `1` Simples, `2` Simples com excesso de sublimite, `3` regime normal (o XML **não** distingue Lucro Real de Presumido — e pro ICMS não importa), `4` MEI.
  - Regime normal → crédito = ICMS destacado (`vICMS` do item; CST 00/10/20/51/70/90). CST 40/41/50/60 → sem crédito.
  - Simples/MEI → crédito = `vCredICMSSN` (só CSOSN 101/201/900 informam; 102/103/300/400/500 → zero).
  - **ICMS-ST** (CST 10/30/60/70, CSOSN 201/202/203/500, ou `vICMSST`/`vBCST` no item) → o ICMS da revenda já foi pago antes: sem débito e sem crédito na revenda daquele item.
- **PIS/COFINS no Lucro Real (não cumulativo)**: crédito de 9,25% sobre a compra pra revenda (`vProd − vDesc`), inclusive de fornecedor do Simples — **exceto** item monofásico/alíquota zero/ST de PIS-COFINS (CST de PIS 04, 05, 06, 07, 08, 09). No Lucro Presumido (cumulativo) não há crédito. Estimativa — o contador confirma por NCM.
- **Simples Nacional — Anexo I (comércio)**, alíquota efetiva = (RBT12 × nominal − parcela a deduzir) ÷ RBT12:

  | Faixa | RBT12 até | Nominal | Deduzir |
  |---|---|---|---|
  | 1ª | R$ 180.000 | 4,00% | 0 |
  | 2ª | R$ 360.000 | 7,30% | 5.940 |
  | 3ª | R$ 720.000 | 9,50% | 13.860 |
  | 4ª | R$ 1.800.000 | 10,70% | 22.500 |
  | 5ª | R$ 3.600.000 | 14,30% | 87.300 |
  | 6ª | R$ 4.800.000 | 19,00% | 378.000 |

  Sublimite estadual (ICMS/ISS fora do DAS acima disso): **R$ 3,6 mi**. Teto do Simples: **R$ 4,8 mi**.
- **Alíquota interestadual de ICMS saindo de SP** (informativo, base das fases 2/3): 12% para Sul e Sudeste (exceto ES); 7% para Norte, Nordeste, Centro-Oeste e ES. Venda pra consumidor final de outro estado → DIFAL (diferença pra alíquota interna do destino).
- **Reforma tributária** (a considerar na fase 3): CBS começa a substituir PIS/COFINS em 2027; Simples ganha a opção "híbrida" de recolher IBS/CBS por fora e repassar crédito; ICMS sai gradualmente entre 2029 e 2033.

Tudo é **estimativa** com parâmetros visíveis — a página não substitui o contador (a opção pelo Simples é feita em janeiro e vale o ano; Lucro Real tem escrituração e contabilidade mais caras).

## Fase 1 (v186) — implementada

Página `pages/financeiro-analise-tributaria.html` (nav do Financeiro "Análise Tributária", logo depois de Compras & CMV; botão no topo de Compras & CMV). Rotas em `server/src/routes/tributario.js` (montadas em `/api/financeiro/tributario`, mesmo gate de admin do Financeiro); regras puras em `server/src/tributario.js` (testadas em `test/tributario.test.js`).

1. **📊 Simples Nacional — onde cada empresa está**: RBT12 (pedidos não cancelados dos últimos 12 meses, ML + Shopee + TikTok, sem Amazon, das lojas ligadas à empresa) → faixa, alíquota nominal e efetiva, quanto falta pra próxima faixa, barra até o teto, e a **soma do grupo** com alerta de sublimite/teto (o aviso dos sócios em comum).
2. **🗺️ Vendas por estado**: período 30/90/365 dias, filtro por empresa; por UF: pedidos, % dos pedidos, faturamento, % do faturamento, barra; SP × fora de SP; alíquota interestadual de cada UF; quantos pedidos estão sem estado (o estado vem do envio — `orders.buyer_state_name`).
3. **🏭 Fornecedores e créditos**: relê os XMLs de compra já guardados (`compras_xml.xml_original` no Supabase — nada é reimportado) e mostra por fornecedor: CNPJ, regime (CRT), notas, total comprado, ICMS destacado, **crédito de ICMS possível**, ICMS-ST, **crédito de PIS/COFINS possível no Lucro Real**, semáforo 🟢 (crédito ≥ 7% da compra) / 🟡 (> 0) / 🔴 (zero), e o % de itens com ST. Totais no rodapé.
4. **🔗 Lojas × empresas**: cada loja de marketplace (tabela `stores` local) ligada à empresa (CNPJ) — sugestão automática pelo nome, editável e salva em `app_config.tributario_lojas_empresa` (JSON `{store_id: empresa}`).

## Fases seguintes (planejadas, aguardando)

- **Fase 2 — XML de venda**: campo de upload (XML solto ou ZIP) + busca automática das NF-e emitidas pelo emissor do Mercado Livre via API; UpSeller por exportação manual (ver se há integração). Por nota: CFOP (5xxx dentro de SP / 6xxx fora), UF do destinatário, ICMS destacado, DIFAL.
- **Fase 3 — Simulador Simples × Presumido × Real** por empresa com 12 meses reais: imposto estimado em cada regime, diferença por ano, ponto de virada; folha = valores transferidos (cenário informal × formalizado); sublimite/teto; reforma tributária.
- **Fase 4 — Contador IA**: parecer escrito sobre os números calculados (a IA só interpreta — padrão do projeto), perguntas livres, checklist pro contador.

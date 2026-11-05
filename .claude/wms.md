# WMS / FinanceEcom — conversa em andamento (guardado em 05/11/2026)

> **Status: NADA implementado ainda.** Pedido do usuário: "guarde tudo isso, vamos conversar amanhã … guarde cada letra". Este arquivo guarda a conversa inteira (palavras do usuário + propostas) pra retomar exatamente daqui. Ao implementar qualquer parte, mover o que virou código para os arquivos de assunto (`embalagem.md`, `modules.md`, `database.md`…) e marcar aqui como feito.

## Visão do usuário (palavras dele)

> "sobre isso financeecom tem que ser o melhor erp ou crm do mundo e você vai me ajudar a tornar isso"

FinanceEcom = o módulo Financeiro (clone/evolução do ERP FinanceEcom do Readdy — ver `modules.md`, "Clone do ERP FinanceEcom"). A direção é transformá-lo num ERP/CRM completo de e-commerce multi-marketplace. Registrado também em `roadmap.md`.

## Perguntas e respostas, na ordem

1. **Usuário:** "wms você sabe o que é?" → Expliquei: Warehouse Management System — recebimento, endereçamento, separação (picking), embalagem/conferência (packing), expedição, inventário, indicadores. O que o dashboard **já tem** de WMS: Embalagem (bipagem da etiqueta + vídeo), Auditoria/Expedição (o que precisa sair e não foi bipado), produtividade por embalador (Tela Telegram), estoque por anúncio (ML/Shopee). O que **falta**: endereço do produto, lista de separação com rota, entrada de mercadoria conferida contra NF, inventário por bipagem, estoque único por SKU somando ML + Shopee.

2. **Usuário:** "dentro do financeecom o que podemos implementar de wms?" → Proposta (8 itens), ligando estoque a dinheiro:
   1. **Custo automático pela NF de compra** — ao importar o XML (Compras & CMV já importa), ler os ITENS da nota (`<det>`: código, EAN, qtd, valor unit.) e atualizar o custo do produto com **custo médio ponderado** → acaba com "produto sem custo" e a margem fica certa sozinha.
   2. **Boletos da NF direto em Boletos** — o XML traz as duplicatas (`<cobr>/<dup>`: vencimento e valor) → lançar em `boletos_mensais` num clique, ligado ao fornecedor.
   3. **Conferir preço da compra** — NF × pedido do Gerador de Pedido; avisar se o fornecedor cobrou mais que o combinado.
   4. **Estoque valorizado** — quanto há parado em estoque em R$ (estoque ML/Shopee × custo), por empresa e por produto.
   5. **Giro e cobertura** — dias de venda que cada produto aguenta, quais estão parados prendendo dinheiro, curva ABC do estoque.
   6. **Sugestão de compra** — pelo giro/cobertura, montar o pedido sugerido já no Gerador de Pedido e mostrar o impacto no Fluxo de Caixa / Projeção.
   7. **Recebimento conferido** — mercadoria chegou → bipar itens contra a NF; faltou/sobrou/avaria vira divergência em R$ pra cobrar do fornecedor.
   8. **Inventário com perda em R$** — contagem por bipagem; diferença vira perda lançada no DRE.
   - Ordem sugerida: **1 e 2** (ganho imediato) → **4 e 5** (dinheiro parado) → **6** (compra inteligente) → **7 e 8** (pedem rotina física de bipagem no depósito).

3. **Usuário:** "são dois gargalos que eu tenho: **bipagem** e **saídas full**".

4. **Usuário (sobre bipagem):** "hoje eu bipo pois vendo muitos kit e não podemos errar — por exemplo 4 latas whiskas, 6 latas whiskas".
   - Diagnóstico: o erro é a **quantidade de unidades dentro do kit** (4 em vez de 6, ou sabor trocado). Hoje só a ETIQUETA é bipada; a tela destaca/fala a quantidade, mas quem conta as latas é o olho do embalador. O sistema **não guarda a composição** dos kits (nenhuma tabela de kit/componente/EAN — conferido no schema).

## Proposta A — Conferência do kit bipando cada unidade (aguardando "aprovado")

1. Bipa a **etiqueta** (como hoje) → tela grande: **"Kit 6 latas × 1 = BIPE 6 LATAS"**.
2. Bipa **cada lata** (código de barras/EAN da embalagem) → contador gigante **2/6 → 3/6 …** + voz contando.
3. Erro: **produto/sabor diferente** → tela vermelha "PRODUTO ERRADO" + bipe de erro; bipou a mais → "SOBROU 1".
4. **Só finaliza** (2º bipe da etiqueta) com **6/6**; tentar antes → trava com "FALTAM 2".
5. Fica registrado junto do vídeo: "conferido 6/6".
- **Aprender a composição sem cadastro prévio:** 1ª vez que um kit é bipado, a tela pergunta "Este anúncio leva quantas unidades? Bipe 1 unidade do produto" — **sugere o número lido do título** ("Kit **8** Latas" → 8, "Kit **10** Unid" → 10). Confirmou + bipou 1 lata → anúncio ensinado. Kit misto (3 carne + 3 frango) = cada EAN com sua quantidade. Produto **sem código de barras** → contagem tocando na tela.
- Impacto: só a tela de Embalagem (+ uma tabela de composição por anúncio/variação, ML e Shopee). Vídeo, etiqueta e o resto iguais.
- **Decisão pendente do usuário:** produto que NÃO é kit (1 unidade) segue como hoje (sem bipe extra) ou também exige o bipe do produto?

## Proposta B — Saídas para o Full (aguardando resposta)

Ainda não existe nada de envio ao Full no sistema (busca por inbound/envio full: zero). Pergunta feita, sem resposta ainda — **onde trava?**
- **a)** decidir **o que e quanto** mandar (o que vai acabar no Full e quanto repor);
- **b)** **etiquetar e contar** as unidades/caixas (demora, erro de quantidade);
- **c)** **acompanhar** o que foi enviado e se o ML recebeu a quantidade certa;
- **d)** outra coisa.
- Ideia já levantada: separar do estoque local as unidades que vão pro Full sem bagunçar o que vende por Flex/Mercado Envios.

## Para retomar amanhã

1. Perguntar a letra do Full (a/b/c/d) e o detalhe do processo de hoje.
2. Confirmar a Proposta A (bipagem de kit) + a decisão do produto de 1 unidade → fazer prévia.
3. Escolher quais dos 8 itens do FinanceEcom entram primeiro (sugestão: 1 e 2).
4. Montar o plano "FinanceEcom melhor ERP/CRM do mundo" (roadmap por fases).

---
name: analisar-vendas
description: Analisa o relatório de vendas baixado do Vendas ML Turbo e entrega insights profundos sobre performance, margem, logística e oportunidades de melhoria.
---

# Skill: Analisar Vendas ML

## O que fazer

O usuário baixou um relatório `.txt` do dashboard Vendas ML Turbo. Você deve:

1. **Ler o arquivo** — peça o caminho ou leia o arquivo fornecido
2. **Parsear as seções** — o arquivo tem seções: KPIs Gerais, Vendas por Loja, Faturamento por Semana, Vendas por Estado, Detalhamento de Vendas
3. **Entregar análise completa** seguindo o template abaixo

## Template de Análise

### 1. 📊 Resumo Executivo
- Receita, lucro e margem do período
- Comparativo com benchmarks do setor (e-commerce BR: margem saudável > 15%)
- Semáforo: 🟢 bom / 🟡 atenção / 🔴 crítico para cada KPI principal

### 2. 🏪 Performance por Loja
- Qual loja lidera em receita vs margem (podem ser diferentes)
- Loja com melhor ROI relativo
- Loja que puxa a margem para baixo e por quê

### 3. 📦 Análise de Produtos
- Top 5 produtos por receita
- Top 5 produtos por margem %
- Produtos com margem negativa (prejuízo por unidade)
- Produtos com alto volume mas baixa margem (candidatos a ajuste de preço)
- Concentração: % da receita nos top 10 produtos (risco de dependência)

### 4. 🚚 Impacto da Logística
- Distribuição Full / Flex / Mercado Envios
- Qual modal tem melhor margem líquida
- Custo de frete vendedor como % da receita
- Recomendação: migrar para Full se margem melhorar

### 5. 📈 Tendência Semanal
- Semana de pico vs semana mais fraca
- Tendência: crescendo, estável ou caindo
- Sazonalidade identificada

### 6. 🌎 Análise Geográfica
- Estados com maior volume
- Oportunidades de expansão geográfica
- Estados com frete vendedor alto (impacto na margem)

### 7. ⚠️ Alertas e Riscos
- Taxa de cancelamento (> 5% = atenção)
- Produtos sem custo cadastrado (margem inflada/incorreta)
- Concentração excessiva em 1 produto ou loja
- ADS/Publicidade como % da receita (> 10% = revisar)
- Tarifas ML como % da receita (benchmark: ~12-16%)

### 8. 💡 Top 5 Recomendações Priorizadas
Liste as 5 ações mais impactantes, ordenadas por:
- Impacto esperado na margem (R$)
- Facilidade de implementação (1-5)
- Prazo sugerido (imediato / 30 dias / 90 dias)

Formato para cada recomendação:
```
**[TÍTULO]** — Impacto estimado: R$ X / Esforço: fácil|médio|difícil
Contexto: [o que os dados mostram]
Ação: [o que fazer exatamente]
```

### 9. 📐 Simulações de Cenário
Calcule o impacto de:
- Reduzir frete vendedor em 20% → novo lucro
- Aumentar margem dos top 3 produtos em 5pp → nova receita
- Eliminar produtos com margem < 0% → impacto

## Instruções de Tom

- Seja direto e objetivo — sem introduções longas
- Use números concretos, não generalizações
- Sinalize claramente o que é dado real vs estimativa
- Se faltar custo de produto nos dados, alerte que a margem calculada está incorreta
- Não elogie gratuitamente — aponte os problemas reais

## Como iniciar

Se o usuário ainda não forneceu o arquivo:
> "Arraste o arquivo `relatorio-ia-YYYY-MM-DD.txt` aqui para eu analisar."

Se forneceu, comece diretamente pela análise sem preâmbulos.

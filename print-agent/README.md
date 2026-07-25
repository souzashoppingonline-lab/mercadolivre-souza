# Print Agent — impressão automática de etiquetas na expedição

Programinha que roda no PC da expedição, puxa as etiquetas geradas pelo dashboard
e imprime **em silêncio** na impressora térmica (ex.: **Elgin PRO FULL**, 10×15 cm).
Sem dependências npm — só Node.js.

## Como funciona

1. O operador bipa a etiqueta no dashboard → o servidor enfileira um job de impressão.
2. Este agente (rodando na expedição) faz polling do servidor, autenticado por um
   **token de estação**.
3. Ao achar um job: baixa o PDF → manda pra impressora via **SumatraPDF** → confirma.

Multi-estação: cada PC/impressora tem sua própria estação (e token). Uma loja
imprime na estação vinculada a ela.

## Pré-requisitos (no PC da expedição, Windows)

1. **Node.js** (LTS) — https://nodejs.org
2. **SumatraPDF** — https://www.sumatrapdfreader.org (impressão silenciosa de PDF).
3. A **Elgin PRO FULL** instalada com o driver, com um **nome fixo** no Windows
   (Painel de Controle → Dispositivos e Impressoras) e o **tamanho de papel 10×15 cm**
   como padrão dela.

## Instalação

1. Copie a pasta `print-agent/` para o PC da expedição.
2. No dashboard, cadastre a estação e pegue o **token** (uma vez):
   ```bash
   curl -X POST https://multimixvendas.duckdns.org/api/print/stations \
     -H "content-type: application/json" \
     -d '{"name":"Expedição UNIFULL","store_id":9100000001,"printer_name":"Elgin PRO FULL"}'
   ```
   (Precisa estar autenticado como staff se o gate estiver ligado — ou rode via a tela de admin.)
   A resposta traz o `token` completo — **anote, não é mostrado de novo**.
3. Copie `config.example.json` para `config.json` e preencha:
   - `stationToken`: o token do passo 2.
   - `printerName`: exatamente o nome da impressora no Windows.
   - `sumatraPath`: caminho do `SumatraPDF.exe`.
4. Rode:
   ```bash
   node agent.js
   ```
   Deve aparecer `[print-agent] iniciado — ...`. Bipe uma etiqueta no dashboard e
   confira se imprime sozinho.

## Autostart (Windows)

Para subir junto com o Windows, crie uma tarefa no **Agendador de Tarefas**:
- Gatilho: "Ao fazer logon".
- Ação: `node` com argumento `C:\caminho\print-agent\agent.js` e "Iniciar em" a pasta do agente.
- Marque "Executar mesmo sem usuário logado" se a expedição usa conta compartilhada.

## Escala da etiqueta

O agente já imprime com `-print-settings noscale` — **não** deixe o Windows
"ajustar à página", senão a 10×15 sai encolhida. Se ainda sair fora de escala,
confirme que o **tamanho de papel padrão da impressora** é 10×15 cm.

## Solução de problemas

- **Não imprime nada**: confira `printerName` (idêntico ao do Windows) e `sumatraPath`.
- **HTTP 401**: `stationToken` errado.
- **Imprime encolhido**: tamanho de papel da impressora não é 10×15 / driver ajustando escala.
- **Nada na fila**: bipe uma etiqueta; veja `GET /api/print/jobs?status=pending` no servidor.

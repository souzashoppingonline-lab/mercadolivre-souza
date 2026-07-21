# Sons do dashboard

## `ml-venda.mp3` — som de venda nova (Mercado Livre)

O alerta de **venda nova** (`WS.on('nova_venda')` em `js/layout.js`) toca este arquivo
quando ele existe. Para usar o **som oficial do Mercado Livre**, salve o arquivo aqui:

```
sounds/ml-venda.mp3
```

- Formato: `.mp3` (ou troque a extensão no `playMlSound()` de `js/layout.js`).
- Se o arquivo **não existir** (ou o navegador bloquear autoplay antes da 1ª
  interação do usuário na página), o dashboard toca automaticamente um **arpejo
  sintetizado** (Web Audio API, sem arquivo externo) como fallback — ninguém
  fica sem alerta sonoro.
- O caminho é servido estaticamente pela raiz do projeto (`/sounds/ml-venda.mp3`).

> Observação: o som oficial do Mercado Livre é material de propriedade do ML —
> use apenas se você tiver o arquivo/permissão. O fallback sintetizado não
> depende de nenhum arquivo de terceiros.

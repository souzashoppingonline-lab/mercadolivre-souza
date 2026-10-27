// Formato do Telegram (parse_mode HTML) → HTML seguro pra Tela Telegram (TV).
// Só passa o que o Telegram aceita: <b>/<strong>, <i>/<em>, <u>/<ins>,
// <s>/<strike>/<del>, <code>, <pre>, <blockquote>, <tg-spoiler>, <a href>
// (só http/https). Qualquer outra tag vira texto escapado; tag aberta sem
// fechar é fechada no fim; \n vira <br>. Navegador (window.TelegramHtml) e
// Node (teste em server/test/telegramHtml.test.js).
(function () {
  const PERMITIDAS = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u', s: 's', strike: 's', del: 's', code: 'code', pre: 'pre', blockquote: 'blockquote', 'tg-spoiler': 'spoiler', span: 'spoiler', a: 'a' };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Texto entre tags já vem com entidades do Telegram (&lt; &amp;…): mantém as
  // entidades conhecidas e escapa o resto.
  const textoSeguro = s => String(s).replace(/&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const desentidade = s => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  function paraHtml(texto, html = true) {
    if (texto == null) return '';
    if (!html) return esc(texto).replace(/\n/g, '<br>');
    const s = String(texto);
    const re = /<(\/?)([a-zA-Z][a-zA-Z-]*)([^<>]*)>/g;
    const pilha = [];
    let out = '', ultimo = 0, m;
    while ((m = re.exec(s))) {
      out += textoSeguro(s.slice(ultimo, m.index)); ultimo = re.lastIndex;
      const fecha = m[1] === '/', tipo = PERMITIDAS[m[2].toLowerCase()];
      if (!tipo || (m[2].toLowerCase() === 'span' && !/tg-spoiler/.test(m[3]) && !fecha)) { out += esc(m[0]); continue; }
      const tag = tipo === 'spoiler' ? 'span' : tipo;
      if (fecha) {
        const i = pilha.lastIndexOf(tag);
        if (i >= 0) while (pilha.length > i) out += `</${pilha.pop()}>`;
        continue;
      }
      if (tag === 'a') {
        const h = /href\s*=\s*"([^"]*)"/i.exec(m[3]) || /href\s*=\s*'([^']*)'/i.exec(m[3]);
        const href = h ? desentidade(h[1]).trim() : '';
        if (/^https?:\/\//i.test(href)) { out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">`; pilha.push('a'); }
        else { out += '<span>'; pilha.push('span'); }
        continue;
      }
      out += tipo === 'spoiler' ? '<span class="tg-spoiler">' : `<${tag}>`;
      pilha.push(tag);
    }
    out += textoSeguro(s.slice(ultimo));
    while (pilha.length) out += `</${pilha.pop()}>`;
    return out.replace(/\n/g, '<br>');
  }

  const API = { paraHtml };
  if (typeof window !== 'undefined') window.TelegramHtml = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();

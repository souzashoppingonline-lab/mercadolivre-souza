// Conversão segura do HTML do Telegram pra Tela Telegram (js/telegramHtml.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { paraHtml } = require('../../js/telegramHtml');

test('mantém o formato do Telegram e quebra linha', () => {
  assert.strictEqual(paraHtml('🔔 <b>CATÁLOGO — UNIFULL</b>\n<i>2 anúncios</i> · <code>MLB123</code>'),
    '🔔 <b>CATÁLOGO — UNIFULL</b><br><i>2 anúncios</i> · <code>MLB123</code>');
  assert.strictEqual(paraHtml('<strong>a</strong><em>b</em><s>c</s>'), '<b>a</b><i>b</i><s>c</s>');
  assert.strictEqual(paraHtml('<a href="https://x.com/a?b=1&amp;c=2">link</a>'), '<a href="https://x.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">link</a>');
});

test('bloqueia o que não é do Telegram (script, onclick, javascript:)', () => {
  assert.strictEqual(paraHtml('<script>alert(1)</script>oi'), '&lt;script&gt;alert(1)&lt;/script&gt;oi');
  assert.strictEqual(paraHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(paraHtml('<a href="javascript:alert(1)">x</a>'), '<span>x</span>');
  assert.strictEqual(paraHtml('<b onclick="x()">a</b>'), '<b>a</b>');
});

test('entidades do Telegram ficam; & solto é escapado; tag aberta é fechada', () => {
  assert.strictEqual(paraHtml('A&amp;B &lt;loja&gt; R&D'), 'A&amp;B &lt;loja&gt; R&amp;D');
  assert.strictEqual(paraHtml('<b>sem fechar'), '<b>sem fechar</b>');
  assert.strictEqual(paraHtml('</i>solto'), 'solto');
  assert.strictEqual(paraHtml('<tg-spoiler>x</tg-spoiler>'), '<span class="tg-spoiler">x</span>');
});

test('texto puro (sem parse_mode): tudo escapado', () => {
  assert.strictEqual(paraHtml('<b>não é negrito</b>\nok', false), '&lt;b&gt;não é negrito&lt;/b&gt;<br>ok');
});

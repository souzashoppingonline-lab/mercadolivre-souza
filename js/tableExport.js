// Exportar qualquer <table> renderizada em CSV — genérico, lê o DOM
// diretamente (thead/tbody), não depende de conhecer a forma dos dados de
// cada página. Usado por páginas de relatório/listagem que não têm um
// exportador dedicado (ver .claude/frontend.md e decisions.md).
function exportTableCSV(table, filename) {
  if (!table) { alert('Tabela não encontrada.'); return; }
  const headRow = table.querySelector('thead tr');
  const bodyRows = [...table.querySelectorAll('tbody tr')].filter(tr => !tr.querySelector('.empty-state, .spinner'));
  if (!bodyRows.length) { alert('Sem dados para exportar.'); return; }

  const cellText = el => el.textContent.replace(/\s+/g, ' ').trim();
  const rows = [];
  if (headRow) rows.push([...headRow.children].map(cellText));
  bodyRows.forEach(tr => rows.push([...tr.children].map(cellText)));

  const escape = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = rows.map(r => r.map(escape).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

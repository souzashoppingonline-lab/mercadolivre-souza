// E-mail de Fechamento Mensal — disparado só ao FINALIZAR um mês (não em
// iniciar/checklist/reabrir). Usa o MESMO Resend já configurado pro resto do
// sistema (resendClient.js, credencial só via .env) — NUNCA o EmailJS que o
// app original (Readdy) usava numa edge function própria com chaves e os 3
// destinatários hardcoded no código. Trocar por Resend também elimina esse
// hardcode: os destinatários são os mesmos de todo relatório por e-mail do
// projeto (RESEND_TO_EMAIL, aceita lista separada por vírgula), não uma
// lista fixa só deste relatório. Ver decisions.md.
const resend = require('./resendClient');

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const BRL = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
const PCT = (v) => `${(Number(v) || 0).toFixed(1).replace('.', ',')}%`;

function kpi(label, valor, cor) {
  return `<div style="flex:1;min-width:130px;background:#f8f8f8;border-radius:8px;padding:12px 14px;margin:4px;">
    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.3px;">${label}</div>
    <div style="font-size:18px;font-weight:800;margin-top:3px;${cor ? `color:${cor};` : ''}">${valor}</div>
  </div>`;
}
function linhaDre(label, valor, destaque) {
  return `<tr>
    <td style="padding:6px 0;font-size:13px;${destaque ? 'font-weight:800;border-top:1px solid #eee;padding-top:10px;' : 'color:#555;'}">${label}</td>
    <td style="padding:6px 0;font-size:13px;text-align:right;${destaque ? 'font-weight:800;border-top:1px solid #eee;padding-top:10px;' : 'color:#555;'}">${valor}</td>
  </tr>`;
}

function buildHtml(report) {
  const r = report;
  const nomeMes = MESES[r.mes - 1] || r.mes;
  const lucroCor = r.lucro_liquido >= 0 ? '#16a34a' : '#dc2626';
  const cresc = r.comparativo_mes_anterior?.revenue_gross
    ? ((r.revenue_gross - r.comparativo_mes_anterior.revenue_gross) / r.comparativo_mes_anterior.revenue_gross) * 100
    : null;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
      <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:22px 24px;">
        <h1 style="font-size:19px;margin:0;color:#fff;">📊 Fechamento Mensal — ${nomeMes}/${r.ano}</h1>
        <p style="font-size:12px;color:#94a3b8;margin:4px 0 0;">Mês fechado e travado como fonte oficial do DRE anual</p>
      </div>
      <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <div style="display:flex;flex-wrap:wrap;margin:0 -4px 18px;">
          ${kpi('Receita Bruta', BRL(r.revenue_gross))}
          ${kpi('Margem Contrib.', `${PCT(r.contribution_margin_pct)}`)}
          ${kpi('Lucro Líquido', BRL(r.lucro_liquido), lucroCor)}
          ${kpi('Vendas', r.total_sales)}
        </div>
        ${cresc != null ? `<p style="font-size:12px;color:${cresc >= 0 ? '#16a34a' : '#dc2626'};margin:0 0 18px;">${cresc >= 0 ? '▲' : '▼'} ${PCT(Math.abs(cresc))} vs. mês anterior (${BRL(r.comparativo_mes_anterior.revenue_gross)})</p>` : ''}

        <h3 style="font-size:14px;margin:18px 0 8px;color:#111;">DRE do mês</h3>
        <table style="width:100%;border-collapse:collapse;">
          ${linhaDre('Receita Bruta', BRL(r.revenue_gross))}
          ${linhaDre('(−) Impostos', BRL(r.tax))}
          ${linhaDre('(−) Taxas Marketplace', BRL(r.marketplace_fees))}
          ${linhaDre('(−) Frete Subsidiado', BRL(r.subsidized_shipping))}
          ${linhaDre('(−) CMV', BRL(r.cogs_total))}
          ${linhaDre('(−) Ads (ML + Externos)', BRL(r.ads_cost_total))}
          ${linhaDre('= Margem de Contribuição', `${BRL(r.contribution_margin)} (${PCT(r.contribution_margin_pct)})`, true)}
          ${linhaDre('(−) Custos Fixos', BRL(r.fixed_costs_total))}
          ${linhaDre('(−) Custos Operacionais', BRL(r.variable_costs_total))}
          ${linhaDre('= Lucro Líquido', `${BRL(r.lucro_liquido)} (${PCT(r.net_pct)})`, true)}
        </table>

        <h3 style="font-size:14px;margin:20px 0 8px;color:#111;">Fluxo de caixa do mês</h3>
        <div style="display:flex;flex-wrap:wrap;margin:0 -4px;">
          ${kpi('Entradas', BRL(r.cash_flow_in), '#16a34a')}
          ${kpi('Saídas', BRL(r.cash_flow_out), '#dc2626')}
          ${kpi('Saldo', BRL(r.cash_flow_balance))}
        </div>

        <h3 style="font-size:14px;margin:20px 0 8px;color:#111;">Boletos</h3>
        <p style="font-size:13px;color:#555;margin:0;">✅ ${r.boletos_paid_count} pago(s) — ${BRL(r.boletos_paid_total)} &nbsp;·&nbsp; ⏳ ${r.boletos_pending_count} pendente(s) — ${BRL(r.boletos_pending_total)}</p>

        ${r.meta ? `<h3 style="font-size:14px;margin:20px 0 8px;color:#111;">Meta do mês</h3><p style="font-size:13px;color:#555;margin:0;">${BRL(r.meta.valor)} · atingido ${r.meta.atingido_pct != null ? PCT(r.meta.atingido_pct) : '—'}</p>` : ''}

        ${(r.expense_categories_top || []).length ? `<h3 style="font-size:14px;margin:20px 0 8px;color:#111;">Top categorias de despesa</h3>
        <table style="width:100%;border-collapse:collapse;">${r.expense_categories_top.map((c) => linhaDre(c.categoria, `${BRL(c.valor)} (${PCT(c.pct)})`)).join('')}</table>` : ''}

        ${r.notes ? `<h3 style="font-size:14px;margin:20px 0 8px;color:#111;">Observações</h3><p style="font-size:13px;color:#555;margin:0;white-space:pre-wrap;">${String(r.notes).replace(/</g, '&lt;')}</p>` : ''}
      </div>
      <p style="text-align:center;font-size:11px;color:#aaa;margin-top:16px;">Enviado automaticamente pelo ML Dashboard ao finalizar o fechamento</p>
    </div>
  </body></html>`;
}

async function sendClosingEmail(report) {
  if (!resend.isConfigured()) {
    console.warn('[fechamento-mensal] RESEND_API_KEY/RESEND_TO_EMAIL não configurados — e-mail não enviado (o fechamento foi salvo normalmente)');
    return { sent: false, reason: 'RESEND não configurado' };
  }
  const nomeMes = MESES[report.mes - 1] || report.mes;
  await resend.sendEmail({ subject: `Fechamento Mensal — ${nomeMes}/${report.ano}`, html: buildHtml(report) });
  return { sent: true };
}

module.exports = { sendClosingEmail, buildHtml };

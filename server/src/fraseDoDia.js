// Frase do dia (Tela Telegram, carrossel) — pedido do usuário: "uma
// inteligência cria, nunca repete". 1 frase por dia (fuso SP), gerada na 1ª
// vez que o painel é pedido no dia e guardada em frases_do_dia. A IA recebe as
// últimas frases e o resultado é conferido contra TODO o histórico
// (normalizado) — repetiu, pede de novo (até 3x). Sem IA configurada (ou se
// falhar), usa a lista de reserva abaixo, sempre a próxima ainda não usada.
const pool = require('./db/pool');
const llm = require('./ai/llm');

const RESERVA = [
  'Cada pacote que sai daqui bem feito é um cliente que volta.',
  'Venda boa não é sorte: é anúncio caprichado, estoque em dia e resposta rápida.',
  'O cliente não vê o nosso esforço — ele vê a caixa chegando certinha. Capricha!',
  'Pequenos ajustes todo dia viram grandes resultados no fim do mês.',
  'Pergunta respondida rápido é venda que não vai pro concorrente.',
  'Hoje é dia de bater o recorde. Bora!',
  'Quem cuida do detalhe ganha a reputação.',
  'Estoque certo, preço certo, entrega no prazo: esse é o nosso jogo.',
  'Um time afinado vende mais do que qualquer promoção.',
  'Cada avaliação positiva começa aqui dentro, na embalagem.',
  'Não é só mais um pedido: é o nome da loja indo junto.',
  'Foco no que dá resultado: o que vende, o que lucra e o que o cliente pede.',
  'Ontem já foi. Hoje é a chance de fazer melhor.',
  'Resolver rápido o problema do cliente vale mais do que qualquer desconto.',
  'Constância vence o pico: fazer bem todo dia é o que ranqueia.',
];
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
let gerando = null; // evita 2 gerações ao mesmo tempo (vários pedidos do painel juntos)

async function gerar(dia, anteriores) {
  const usadas = new Set(anteriores.map(a => norm(a.frase)));
  if (llm.isConfigured()) {
    const data = new Date(`${dia}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC' });
    const system = 'Você escreve UMA frase curta (máx. 140 caracteres), em português do Brasil, para a TV da equipe de uma loja de e-commerce que vende no Mercado Livre e na Shopee (atendimento, embalagem, expedição, anúncios, estoque). Motivacional ou recado prático do dia, positivo, sem clichê de coach, sem hashtags, sem aspas, no máximo 1 emoji. Responda SÓ a frase.';
    for (let t = 0; t < 3; t++) {
      try {
        const user = `Hoje é ${data}. NÃO repita nem parafraseie nenhuma destas frases já usadas:\n${anteriores.slice(0, 120).map(a => '- ' + a.frase).join('\n') || '(nenhuma ainda)'}\nEscreva uma frase nova${t ? ' (bem diferente das anteriores)' : ''}.`;
        const f = (await llm.complete({ system, user, maxTokens: 120, feature: 'frase-do-dia' })).trim().replace(/^["'“]|["'”]$/g, '').slice(0, 200);
        if (f && !usadas.has(norm(f))) return { frase: f, origem: 'ia' };
      } catch (e) { console.warn('[frase-do-dia] IA falhou:', e.message); break; }
    }
  }
  const prox = RESERVA.find(r => !usadas.has(norm(r)));
  return prox ? { frase: prox, origem: 'reserva' } : null;
}

async function obterFraseDoDia() {
  const dia = hojeSP();
  const { rows } = await pool.query(`SELECT frase, origem FROM frases_do_dia WHERE dia = $1`, [dia]);
  if (rows[0]) return rows[0];
  if (!gerando) {
    gerando = (async () => {
      const { rows: ant } = await pool.query(`SELECT frase FROM frases_do_dia ORDER BY dia DESC`);
      const nova = await gerar(dia, ant);
      if (nova) await pool.query(`INSERT INTO frases_do_dia (dia, frase, origem) VALUES ($1,$2,$3) ON CONFLICT (dia) DO NOTHING`, [dia, nova.frase, nova.origem]);
    })().finally(() => { gerando = null; });
  }
  await gerando;
  const { rows: r2 } = await pool.query(`SELECT frase, origem FROM frases_do_dia WHERE dia = $1`, [dia]);
  return r2[0] || null;
}

module.exports = { obterFraseDoDia, gerar, RESERVA, norm };

// Veículos animados (desenhos próprios em SVG, sem logo de marca) — fonte única
// usada por pages/tela-telegram.html (venda nova por logística, v166) e
// pages/embalagem.html (passa na tela na hora da bipagem, v168).
//   Veiculos.RODA(cx, cy, r)      → roda (gira com a classe .roda)
//   Veiculos.svgMoto(textoBau)    → moto com baú (Flex)
//   Veiculos.SVG_PICAPE           → picape compacta branca, cabine simples, caixa
//                                   "MERCADO ENVIOS" na caçamba (estilo Montana 2017,
//                                   pedido do usuário — sem o símbolo da montadora)
//   Veiculos.passar(tipo, opts)   → atravessa a tela da esquerda pra direita
//                                   (tipo 'moto' | 'picape'); some sozinho no fim.
// Ver .claude/frontend.md (Tela Telegram) e .claude/embalagem.md.
(function () {
  const RODA = (cx, cy, r) => `<g class="roda"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#1f2937"/><circle cx="${cx}" cy="${cy}" r="${r * .45}" fill="#9ca3af"/><path d="M${cx} ${cy - r * .8} v${r * 1.6} M${cx - r * .8} ${cy} h${r * 1.6}" stroke="#4b5563" stroke-width="2.5"/></g>`;

  const svgMoto = (textoBau = '') => `<svg viewBox="0 0 220 140" aria-hidden="true"><ellipse cx="110" cy="134" rx="98" ry="5" fill="rgba(0,0,0,.35)"/>
  <g class="carro"><rect x="6" y="36" width="58" height="44" rx="6" fill="#f97316" stroke="#9a3412" stroke-width="3"/><path d="M6 50 h58" stroke="#9a3412" stroke-width="2" opacity=".6"/>
  ${textoBau ? `<text x="35" y="70" text-anchor="middle" font-size="13" font-weight="900" fill="#fff" font-family="Arial,sans-serif">${textoBau}</text>` : ''}
  <path d="M44 80 L66 84" stroke="#374151" stroke-width="5"/>
  <path d="M45 112 L90 82 L150 82 L175 112" stroke="#374151" stroke-width="6" fill="none" stroke-linejoin="round"/>
  <path d="M86 72 q22 -14 54 -6 l14 14 h-72z" fill="#dc2626" stroke="#7f1d1d" stroke-width="2"/>
  <rect x="68" y="64" width="42" height="9" rx="4" fill="#111827"/>
  <path d="M160 54 L175 112" stroke="#6b7280" stroke-width="6"/><path d="M150 52 h20" stroke="#111827" stroke-width="5" stroke-linecap="round"/>
  <circle cx="172" cy="64" r="5" fill="#fde68a"/>
  <path d="M104 66 L128 78 L130 100" stroke="#1e3a8a" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M98 64 q4 -26 26 -30 l10 4 q-8 14 -10 28z" fill="#2563eb"/><path d="M128 42 L154 52" stroke="#2563eb" stroke-width="7" stroke-linecap="round"/>
  <circle cx="130" cy="25" r="12" fill="#facc15" stroke="#a16207" stroke-width="2"/><path d="M134 21 h8 v8 h-6z" fill="#1f2937"/></g>
  ${RODA(45, 112, 20)}${RODA(175, 112, 20)}</svg>`;

  // Picape compacta branca de cabine simples (silhueta estilo Montana 2017: capô
  // curto e inclinado, para-brisa bem deitado, caçamba alta) com uma caixa de
  // papelão na caçamba. Virada pra direita (anda pra direita).
  const SVG_PICAPE = `<svg viewBox="0 0 260 128" aria-hidden="true"><ellipse cx="130" cy="120" rx="118" ry="6" fill="rgba(0,0,0,.35)"/>
  <g class="carro">
    <g transform="translate(18 8)"><rect width="104" height="50" rx="3" fill="#c98a3d" stroke="#8a5a20" stroke-width="2.5"/><path d="M0 13 h104 M52 0 v13" stroke="#8a5a20" stroke-width="2"/>
      <text x="52" y="36" text-anchor="middle" font-size="12" font-weight="900" fill="#3b2a12" font-family="Arial,sans-serif" textLength="94" lengthAdjust="spacingAndGlyphs">MERCADO ENVIOS</text></g>
    <path d="M8 56 h138 l14 -24 q5 -8 15 -8 h20 q10 0 16 6 l22 24 q16 2 22 8 q5 5 5 12 v14 q0 7 -7 7 h-238 q-7 0 -7 -7 v-24 q0 -8 8 -8z" fill="#f8fafc" stroke="#94a3b8" stroke-width="3" stroke-linejoin="round"/>
    <path d="M8 58 h138" stroke="#cbd5e1" stroke-width="3"/>
    <path d="M152 54 l11 -20 q4 -6 10 -6 h14 v26z" fill="#9fd3f5" stroke="#475569" stroke-width="2" stroke-linejoin="round"/>
    <path d="M192 28 h4 q7 0 12 5 l19 21 h-35z" fill="#9fd3f5" stroke="#475569" stroke-width="2" stroke-linejoin="round"/>
    <path d="M188 28 v26" stroke="#475569" stroke-width="3"/>
    <path d="M188 58 v30 M150 58 v30" stroke="#cbd5e1" stroke-width="2"/>
    <rect x="176" y="64" width="10" height="3" rx="1.5" fill="#64748b"/>
    <path d="M246 70 h8 v8 h-8z" fill="#fde68a" stroke="#ca8a04" stroke-width="1.5"/>
    <rect x="236" y="88" width="22" height="7" rx="3" fill="#475569"/>
    <rect x="4" y="62" width="6" height="12" rx="1" fill="#ef4444"/>
    <path d="M44 84 a20 20 0 0 1 40 0 M182 84 a20 20 0 0 1 40 0" fill="none" stroke="#94a3b8" stroke-width="3"/>
  </g>
  ${RODA(64, 98, 17)}${RODA(202, 98, 17)}</svg>`;

  let cssPronto = false;
  function css() {
    if (cssPronto) return; cssPronto = true;
    const st = document.createElement('style');
    st.textContent = `
      .veic-passa { position:fixed; left:0; bottom:18px; z-index:99990; pointer-events:none; animation:veicAnda var(--dur,4s) linear forwards; }
      .veic-passa svg { display:block; width:100%; overflow:visible; }
      .veic-passa .roda { transform-box:fill-box; transform-origin:center; animation:veicRoda .45s linear infinite; }
      .veic-passa .carro { animation:veicTreme .3s ease-in-out infinite; }
      @keyframes veicAnda { from { transform:translateX(-100%); } to { transform:translateX(calc(100vw + 40px)); } }
      @keyframes veicRoda { to { transform:rotate(360deg); } }
      @keyframes veicTreme { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-3px); } }
      @media (prefers-reduced-motion: reduce) { .veic-passa { display:none; } }`;
    document.head.appendChild(st);
  }

  // Passa 1 veículo pela tela (não bloqueia clique nem foco — pointer-events:none).
  // `largura`: px (número) ou qualquer medida CSS (ex.: '70vw').
  function passar(tipo, { duracao = 4000, largura } = {}) {
    css();
    const svg = tipo === 'moto' ? svgMoto('FLEX') : tipo === 'picape' ? SVG_PICAPE : '';
    if (!svg) return null;
    const el = document.createElement('div');
    el.className = 'veic-passa veic-' + tipo;
    const w = largura || (tipo === 'moto' ? 240 : 320);
    el.style.width = typeof w === 'number' ? w + 'px' : w;
    el.style.setProperty('--dur', duracao + 'ms');
    el.innerHTML = svg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duracao + 100);
    return el;
  }

  window.Veiculos = { RODA, svgMoto, SVG_PICAPE, passar };
})();

// Extração dos campos do VENDEDOR de GET /shipments/:id/costs (mlClient.
// getShipmentCosts) — fonte única, usada por worker.js (handleShipment,
// webhook de status de envio) e financeService.js (reconciliarPedido, botão
// manual + job automático). Nunca duas cópias da mesma extração (as duas
// tinham a mesma lógica de `senders.reduce(...)` duplicada antes desta
// tarefa — extraído quando a 2ª necessidade, capturar `save`/`compensation`
// além de `cost`, apareceu).
//
// `sellerCost` = quanto o vendedor efetivamente PAGA pelo envio (já existia,
// vira orders.shipping_seller_cost).
// `sellerReembolso` = quanto o Mercado Livre efetivamente DEVOLVE/credita ao
// vendedor nesse envio (`senders[].save` + `senders[].compensation` — campos
// distintos de desconto/compensação do LADO DO VENDEDOR, nunca confundir com
// `receiver.save`/`receiver.discounts`, que é o subsídio de frete grátis
// PRO COMPRADOR — ver business-rules.md "Frete Flex — subsídio ao
// comprador, não ao vendedor"). Em toda amostra real testada até agora
// (2 vendas Flex, ver decisions.md), os dois vieram 0 — a extração já está
// pronta pra quando/se um caso real de reembolso ao vendedor aparecer.
function extrairCustosVendedor(costs) {
  const senders = costs?.senders;
  const lista = Array.isArray(senders) ? senders : (senders ? [senders] : []);
  if (!lista.length) return { sellerCost: null, sellerReembolso: 0 };
  const sellerCost = lista.reduce((a, s) => a + (Number(s?.cost) || 0), 0);
  const sellerReembolso = lista.reduce((a, s) => a + (Number(s?.save) || 0) + (Number(s?.compensation) || 0), 0);
  return { sellerCost, sellerReembolso };
}

module.exports = { extrairCustosVendedor };

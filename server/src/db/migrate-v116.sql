-- Notificação push da página "Dívidas do Dia" (PWA, v116). Uma linha por
-- aparelho/navegador inscrito (PushSubscription do navegador). Gravada por
-- POST /api/financeiro/push/inscrever; lida pelo job checkDividasPush do
-- worker.js (07:00). Inscrição que o serviço de push recusa com 404/410 é
-- apagada no envio. Chaves VAPID ficam em app_config (push_vapid_public /
-- push_vapid_private), geradas sozinhas no 1º uso. Ver .claude/database.md.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  topico TEXT NOT NULL DEFAULT 'dividas',
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  fail_count INT NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS push_subscriptions_topico_idx ON push_subscriptions (topico);

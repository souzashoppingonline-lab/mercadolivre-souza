-- v104: aviso "embale bem" na Embalagem para comprador fora de São Paulo.
-- state.id/name vêm de receiver_address.state (GET /shipments/:id, ML) —
-- ver embalagem.md e decisions.md.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_state_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_state_name TEXT;

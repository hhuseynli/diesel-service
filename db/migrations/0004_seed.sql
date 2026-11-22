-- The system user and the first settings (plan 01, migration 0004).
-- The system user cannot log in and can act only in a migration-role session.
SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000001', true);
--> statement-breakpoint
SELECT set_config('app.reason', 'seed', true);
--> statement-breakpoint
INSERT INTO users (id, full_name, phone, is_active, is_system)
VALUES ('00000000-0000-0000-0000-000000000001', 'Sistem', '+000000000', false, true);
--> statement-breakpoint
-- Company details print on every document (spec 00, section 2). VOEN, address and
-- bank are filled in as a new settings row once known (plan 01, open item O1).
INSERT INTO settings (key, value, effective_from) VALUES
  ('company',
   '{"legal_name": "Highest Service MMC", "voen": null, "address": null, "bank": null}',
   '2026-01-01 00:00:00+04'),
  ('vat_rate', '{"percent": "18.00"}', '2026-01-01 00:00:00+04');
--> statement-breakpoint
SELECT set_config('app.user_id', '', true);
--> statement-breakpoint
SELECT set_config('app.reason', '', true);

ALTER TABLE "user_roles" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "contragents" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "vehicle_plates" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "vehicles" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "document_lines" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "document_counters" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "created_by" SET DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid;
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "user_roles_role" CHECK (role IN ('OWNER', 'MANAGEMENT', 'FORMEN', 'WAREHOUSEMAN', 'CASHIER', 'BOOKKEEPER', 'MECHANIC')),
	CONSTRAINT "user_roles_revoked_together" CHECK (("user_roles"."revoked_at" IS NULL AND "user_roles"."revoked_by" IS NULL AND "user_roles"."revoke_reason" IS NULL)
        OR ("user_roles"."revoked_at" IS NOT NULL AND "user_roles"."revoked_by" IS NOT NULL AND btrim("user_roles"."revoke_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"pin_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_phone_format" CHECK ("users"."phone" ~ '^\+[0-9]{8,15}$'),
	CONSTRAINT "users_full_name_not_blank" CHECK (btrim("users"."full_name") <> '')
);
--> statement-breakpoint
CREATE TABLE "contragents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"voen" text,
	"phone" text,
	"email" text,
	"address" text,
	"bank_details" jsonb,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "contragents_kind" CHECK ("contragents"."kind" IN ('FIZIKI', 'HUQUQI')),
	CONSTRAINT "contragents_name_not_blank" CHECK (btrim("contragents"."name") <> ''),
	CONSTRAINT "contragents_voen_format" CHECK ("contragents"."voen" ~ '^[0-9]{10}$'),
	CONSTRAINT "contragents_customer_or_supplier" CHECK ("contragents"."is_customer" OR "contragents"."is_supplier")
);
--> statement-breakpoint
CREATE TABLE "vehicle_plates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"plate_display" text NOT NULL,
	"plate_normalized" text GENERATED ALWAYS AS (upper(regexp_replace(plate_display, '[[:space:]-]', '', 'g'))) STORED NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"job_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "vehicle_plates_status" CHECK ("vehicle_plates"."status" IN ('ACTIVE', 'ENDED', 'UNCONFIRMED')),
	CONSTRAINT "vehicle_plates_source" CHECK ("vehicle_plates"."source" IN ('INTAKE', 'CONTRACT', 'IMPORT')),
	CONSTRAINT "vehicle_plates_ended_has_valid_to" CHECK (("vehicle_plates"."status" = 'ENDED') = ("vehicle_plates"."valid_to" IS NOT NULL)),
	CONSTRAINT "vehicle_plates_dates" CHECK ("vehicle_plates"."valid_to" >= "vehicle_plates"."valid_from"),
	CONSTRAINT "vehicle_plates_display_length" CHECK (length("vehicle_plates"."plate_display") BETWEEN 1 AND 20),
	CONSTRAINT "vehicle_plates_normalized_not_empty" CHECK ("vehicle_plates"."plate_normalized" <> '')
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vin" text NOT NULL,
	"make" text,
	"model" text,
	"year" smallint,
	"engine" text,
	"qr_token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL,
	"decode_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "vehicles_vin_unique" UNIQUE("vin"),
	CONSTRAINT "vehicles_qr_token_unique" UNIQUE("qr_token"),
	CONSTRAINT "vehicles_vin_format" CHECK ("vehicles"."vin" ~ '^[A-HJ-NPR-Z0-9]{17}$'),
	CONSTRAINT "vehicles_year_range" CHECK ("vehicles"."year" BETWEEN 1950 AND 2100)
);
--> statement-breakpoint
CREATE TABLE "document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" uuid,
	"quantity" numeric(12, 3) NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_reason" text,
	"vat_rate" numeric(5, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "document_lines_document_line_no" UNIQUE("document_id","line_no"),
	CONSTRAINT "document_lines_line_no" CHECK ("document_lines"."line_no" >= 1),
	CONSTRAINT "document_lines_quantity_not_zero" CHECK ("document_lines"."quantity" <> 0),
	CONSTRAINT "document_lines_discount_not_negative" CHECK ("document_lines"."discount" >= 0),
	CONSTRAINT "document_lines_discount_reason" CHECK ("document_lines"."discount" = 0 OR ("document_lines"."discount_reason" IS NOT NULL AND btrim("document_lines"."discount_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"number" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"doc_date" date,
	"job_order_id" uuid,
	"vehicle_id" uuid,
	"contragent_id" uuid,
	"vin_snapshot" text,
	"plate_snapshot" text,
	"vat_rate" numeric(5, 2),
	"total_ex_vat" numeric(14, 2) DEFAULT '0' NOT NULL,
	"vat_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"supersedes_id" uuid,
	"reverses_id" uuid,
	"annul_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "documents_supersedes_id_unique" UNIQUE("supersedes_id"),
	CONSTRAINT "documents_type_number_version" UNIQUE("type","number","version"),
	CONSTRAINT "documents_type" CHECK (type IN ('QUSUR_AKTI', 'ELAVE_AKT', 'QIYMET_PROTOKOLU', 'TEHVIL_TESLIM', 'SATIS', 'ALIS', 'MEDAXIL', 'MEXARIC', 'SILINME', 'INVENTAR')),
	CONSTRAINT "documents_status" CHECK (status IN ('DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED', 'POSTED', 'ANNULLED')),
	CONSTRAINT "documents_number_format" CHECK ("documents"."number" ~ '^[A-Z]{2}-[0-9]{4}-[0-9]{6}$'),
	CONSTRAINT "documents_number_by_status" CHECK (("documents"."status" = 'DRAFT' AND "documents"."number" IS NULL)
        OR ("documents"."status" IN ('SUBMITTED', 'REJECTED', 'APPROVED', 'POSTED') AND "documents"."number" IS NOT NULL)
        OR "documents"."status" = 'ANNULLED'),
	CONSTRAINT "documents_annul_reason" CHECK (("documents"."status" = 'ANNULLED') = ("documents"."annul_reason" IS NOT NULL AND btrim("documents"."annul_reason") <> '')),
	CONSTRAINT "documents_total" CHECK ("documents"."total" = "documents"."total_ex_vat" + "documents"."vat_amount"),
	CONSTRAINT "documents_version" CHECK ("documents"."version" >= 1),
	CONSTRAINT "documents_version_has_predecessor" CHECK (("documents"."version" > 1) = ("documents"."supersedes_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"linked_table" text,
	"linked_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "attachments_sha256" CHECK ("attachments"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attachments_size" CHECK ("attachments"."size_bytes" > 0),
	CONSTRAINT "attachments_link_pair" CHECK (("attachments"."linked_table" IS NULL) = ("attachments"."linked_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"txid" bigint DEFAULT txid_current() NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"user_id" uuid,
	"reason" text,
	"details" jsonb,
	CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" IN ('INSERT', 'UPDATE', 'DENIED')),
	CONSTRAINT "audit_log_user" CHECK ("audit_log"."user_id" IS NOT NULL OR "audit_log"."action" = 'DENIED')
);
--> statement-breakpoint
CREATE TABLE "document_counters" (
	"doc_type" text NOT NULL,
	"year" integer NOT NULL,
	"last_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "document_counters_doc_type_year_pk" PRIMARY KEY("doc_type","year"),
	CONSTRAINT "document_counters_range" CHECK ("document_counters"."last_number" BETWEEN 1 AND 999999)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (current_setting('app.user_id', true))::uuid NOT NULL,
	CONSTRAINT "settings_key_effective_from" UNIQUE("key","effective_from")
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contragents" ADD CONSTRAINT "contragents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_plates" ADD CONSTRAINT "vehicle_plates_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_plates" ADD CONSTRAINT "vehicle_plates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_contragent_id_contragents_id_fk" FOREIGN KEY ("contragent_id") REFERENCES "public"."contragents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_supersedes_id_documents_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reverses_id_documents_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_one_active" ON "user_roles" USING btree ("user_id","role") WHERE "user_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_system_user" ON "users" USING btree ("is_system") WHERE "users"."is_system";--> statement-breakpoint
CREATE UNIQUE INDEX "contragents_voen_unique" ON "contragents" USING btree ("voen") WHERE "contragents"."voen" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_plates_one_active_per_vehicle" ON "vehicle_plates" USING btree ("vehicle_id") WHERE "vehicle_plates"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_plates_one_active_per_plate" ON "vehicle_plates" USING btree ("plate_normalized") WHERE "vehicle_plates"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "vehicle_plates_search" ON "vehicle_plates" USING btree ("plate_normalized" text_pattern_ops);
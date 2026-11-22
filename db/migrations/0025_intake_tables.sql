CREATE TABLE "document_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"signer_name" text NOT NULL,
	"signer_phone" text NOT NULL,
	"signature_attachment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "document_signatures_document_id_unique" UNIQUE("document_id"),
	CONSTRAINT "document_signatures_signer" CHECK (btrim("document_signatures"."signer_name") <> '' AND btrim("document_signatures"."signer_phone") <> '')
);
--> statement-breakpoint
CREATE TABLE "inspection_finding_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "inspection_finding_attachments_pair" UNIQUE("finding_id","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "inspection_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_order_id" uuid NOT NULL,
	"mechanic_id" uuid NOT NULL,
	"description" text NOT NULL,
	"additional" boolean DEFAULT false NOT NULL,
	"corrects_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "inspection_findings_description" CHECK (btrim("inspection_findings"."description") <> '')
);
--> statement-breakpoint
CREATE TABLE "intake_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_order_id" uuid NOT NULL,
	"method" text NOT NULL,
	"signer_name" text NOT NULL,
	"signer_phone" text NOT NULL,
	"signature_attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "intake_confirmations_job_order_id_unique" UNIQUE("job_order_id"),
	CONSTRAINT "intake_confirmations_method" CHECK ("intake_confirmations"."method" IN ('SIGNATURE', 'OTP')),
	CONSTRAINT "intake_confirmations_signature" CHECK ("intake_confirmations"."method" <> 'SIGNATURE' OR "intake_confirmations"."signature_attachment_id" IS NOT NULL),
	CONSTRAINT "intake_confirmations_signer" CHECK (btrim("intake_confirmations"."signer_name") <> '' AND btrim("intake_confirmations"."signer_phone") <> '')
);
--> statement-breakpoint
CREATE TABLE "intake_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_order_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "intake_photos_job_slot" UNIQUE("job_order_id","slot"),
	CONSTRAINT "intake_photos_slot" CHECK ("intake_photos"."slot" IN ('ODOMETER', 'FRONT', 'REAR', 'LEFT', 'RIGHT', 'DASHBOARD'))
);
--> statement-breakpoint
CREATE TABLE "odometer_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"value_km" integer NOT NULL,
	"photo_id" uuid NOT NULL,
	"below_previous" boolean DEFAULT false NOT NULL,
	"above_daily_limit" boolean DEFAULT false NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "odometer_readings_job_order_id_unique" UNIQUE("job_order_id"),
	CONSTRAINT "odometer_readings_value" CHECK ("odometer_readings"."value_km" >= 0),
	CONSTRAINT "odometer_readings_reason" CHECK (NOT "odometer_readings"."below_previous" OR ("odometer_readings"."reason" IS NOT NULL AND btrim("odometer_readings"."reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "parts_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_order_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit_hint" text,
	"status" text DEFAULT 'NEW' NOT NULL,
	"matched_item_id" uuid,
	"additional" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "parts_requests_status" CHECK ("parts_requests"."status" IN ('NEW', 'MATCHED', 'CANCELLED')),
	CONSTRAINT "parts_requests_quantity" CHECK ("parts_requests"."quantity" > 0),
	CONSTRAINT "parts_requests_matched" CHECK (("parts_requests"."status" = 'MATCHED') = ("parts_requests"."matched_item_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "planned_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_order_id" uuid NOT NULL,
	"description" text NOT NULL,
	"item_id" uuid,
	"mechanic_id" uuid,
	"additional" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qr_stickers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"qr_token" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"replace_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "qr_stickers_qr_token_unique" UNIQUE("qr_token"),
	CONSTRAINT "qr_stickers_status" CHECK ("qr_stickers"."status" IN ('ACTIVE', 'REPLACED')),
	CONSTRAINT "qr_stickers_replace_reason" CHECK (("qr_stickers"."status" = 'REPLACED') = ("qr_stickers"."replace_reason" IS NOT NULL AND btrim("qr_stickers"."replace_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "quality_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_order_id" uuid NOT NULL,
	"mechanic_id" uuid,
	"items_checked" jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"dashboard_photo_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "removed_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_order_id" uuid NOT NULL,
	"description" text NOT NULL,
	"photo_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "removed_parts_disposition" CHECK ("removed_parts"."disposition" IN ('RETURNED_TO_CLIENT', 'DISPOSED', 'WARRANTY_CLAIM'))
);
--> statement-breakpoint
CREATE TABLE "vin_decodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vin" text NOT NULL,
	"provider" text NOT NULL,
	"raw_response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "capture_time" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "capture_check" text;--> statement-breakpoint
ALTER TABLE "job_orders" ADD COLUMN "owner_changed" boolean;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_signature_attachment_id_attachments_id_fk" FOREIGN KEY ("signature_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_finding_attachments" ADD CONSTRAINT "inspection_finding_attachments_finding_id_inspection_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."inspection_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_finding_attachments" ADD CONSTRAINT "inspection_finding_attachments_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_finding_attachments" ADD CONSTRAINT "inspection_finding_attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_mechanic_id_users_id_fk" FOREIGN KEY ("mechanic_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_corrects_id_inspection_findings_id_fk" FOREIGN KEY ("corrects_id") REFERENCES "public"."inspection_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_confirmations" ADD CONSTRAINT "intake_confirmations_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_confirmations" ADD CONSTRAINT "intake_confirmations_signature_attachment_id_attachments_id_fk" FOREIGN KEY ("signature_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_confirmations" ADD CONSTRAINT "intake_confirmations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_photos" ADD CONSTRAINT "intake_photos_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_photos" ADD CONSTRAINT "intake_photos_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_photos" ADD CONSTRAINT "intake_photos_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_photo_id_attachments_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts_requests" ADD CONSTRAINT "parts_requests_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts_requests" ADD CONSTRAINT "parts_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_services" ADD CONSTRAINT "planned_services_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_services" ADD CONSTRAINT "planned_services_mechanic_id_users_id_fk" FOREIGN KEY ("mechanic_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_services" ADD CONSTRAINT "planned_services_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_stickers" ADD CONSTRAINT "qr_stickers_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_stickers" ADD CONSTRAINT "qr_stickers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_mechanic_id_users_id_fk" FOREIGN KEY ("mechanic_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_dashboard_photo_id_attachments_id_fk" FOREIGN KEY ("dashboard_photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removed_parts" ADD CONSTRAINT "removed_parts_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removed_parts" ADD CONSTRAINT "removed_parts_photo_id_attachments_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removed_parts" ADD CONSTRAINT "removed_parts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vin_decodes" ADD CONSTRAINT "vin_decodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qr_stickers_one_active_per_vehicle" ON "qr_stickers" USING btree ("vehicle_id") WHERE "qr_stickers"."status" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_capture_check" CHECK ("attachments"."capture_check" IN ('CAMERA_OK', 'CAPTURE_TIME_OFF', 'NO_CAPTURE_TIME'));
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"success" boolean NOT NULL,
	"device_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_attempts_kind" CHECK ("login_attempts"."kind" IN ('PIN', 'PASSWORD', 'TOTP', 'UNLOCK', 'SIGN_OUT'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_kind" CHECK ("sessions"."kind" IN ('OFFICE', 'TABLET')),
	CONSTRAINT "sessions_tablet_device" CHECK (("sessions"."kind" = 'TABLET') = ("sessions"."device_id" IS NOT NULL)),
	CONSTRAINT "sessions_end" CHECK (("sessions"."ended_at" IS NULL) = ("sessions"."end_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "tablet_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "tablet_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"step_no" integer NOT NULL,
	"required_role" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"method" text DEFAULT 'MANUAL' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "approvals_document_round_step" UNIQUE("document_id","round","step_no"),
	CONSTRAINT "approvals_round_step" CHECK ("approvals"."round" >= 1 AND "approvals"."step_no" >= 1),
	CONSTRAINT "approvals_required_role" CHECK ("approvals"."required_role" IN ('OWNER', 'MANAGEMENT', 'FORMEN', 'WAREHOUSEMAN', 'CASHIER', 'BOOKKEEPER', 'MECHANIC', 'CLIENT')),
	CONSTRAINT "approvals_status" CHECK ("approvals"."status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
	CONSTRAINT "approvals_method" CHECK ("approvals"."method" IN ('MANUAL', 'AUTO')),
	CONSTRAINT "approvals_decided" CHECK (("approvals"."status" IN ('APPROVED', 'REJECTED')) = ("approvals"."decided_at" IS NOT NULL)
        AND ("approvals"."status" NOT IN ('APPROVED', 'REJECTED') OR "approvals"."decided_by" IS NOT NULL OR "approvals"."method" = 'AUTO')),
	CONSTRAINT "approvals_reject_comment" CHECK ("approvals"."status" <> 'REJECTED' OR ("approvals"."comment" IS NOT NULL AND btrim("approvals"."comment") <> ''))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lock_reason" text;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_device_id_tablet_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."tablet_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_tablet_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."tablet_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tablet_devices" ADD CONSTRAINT "tablet_devices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_lock_reason" CHECK (("users"."locked_at" IS NULL) = ("users"."lock_reason" IS NULL));
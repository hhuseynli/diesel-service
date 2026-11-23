ALTER TABLE "users" DROP CONSTRAINT "users_lock_reason";--> statement-breakpoint
ALTER TABLE "login_attempts" ADD COLUMN "recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "locked_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "lock_reason";--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_unlock" CHECK (("login_attempts"."kind" = 'UNLOCK') = ("login_attempts"."recorded_by" IS NOT NULL AND btrim(coalesce("login_attempts"."reason", '')) <> ''));
ALTER TABLE "inspection_findings" ADD COLUMN "correction_reason" text;--> statement-breakpoint
ALTER TABLE "intake_confirmations" ADD COLUMN "vin_check" text NOT NULL;--> statement-breakpoint
ALTER TABLE "removed_parts" ADD COLUMN "mechanic_id" uuid;--> statement-breakpoint
ALTER TABLE "removed_parts" ADD CONSTRAINT "removed_parts_mechanic_id_users_id_fk" FOREIGN KEY ("mechanic_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_photos" ADD CONSTRAINT "intake_photos_attachment" UNIQUE("attachment_id");--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_correction_reason" CHECK (("inspection_findings"."corrects_id" IS NULL AND "inspection_findings"."correction_reason" IS NULL)
          OR ("inspection_findings"."corrects_id" IS NOT NULL AND btrim("inspection_findings"."correction_reason") <> ''));--> statement-breakpoint
ALTER TABLE "intake_confirmations" ADD CONSTRAINT "intake_confirmations_vin_check" CHECK ("intake_confirmations"."vin_check" IN ('LAST6_CONFIRMED', 'NEW_VEHICLE'));
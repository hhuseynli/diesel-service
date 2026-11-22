CREATE TABLE "contract_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"contract_plate" text,
	"added_on" date DEFAULT baku_date() NOT NULL,
	"removed_on" date,
	"removed_by" uuid,
	"remove_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "contract_vehicles_removed_together" CHECK (("contract_vehicles"."removed_on" IS NULL AND "contract_vehicles"."removed_by" IS NULL AND "contract_vehicles"."remove_reason" IS NULL)
        OR ("contract_vehicles"."removed_on" IS NOT NULL AND "contract_vehicles"."removed_by" IS NOT NULL AND btrim("contract_vehicles"."remove_reason") <> '')),
	CONSTRAINT "contract_vehicles_dates" CHECK ("contract_vehicles"."removed_on" IS NULL OR "contract_vehicles"."removed_on" >= "contract_vehicles"."added_on")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contragent_id" uuid NOT NULL,
	"number" text NOT NULL,
	"signed_on" date NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"deferred_payment_days" integer DEFAULT 0 NOT NULL,
	"advance_threshold_ex_vat" numeric(14, 2),
	"advance_percent" numeric(5, 2),
	"penalty_rate_daily" numeric(7, 4),
	"penalty_cap_percent" numeric(5, 2),
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "contracts_contragent_number" UNIQUE("contragent_id","number"),
	CONSTRAINT "contracts_status" CHECK ("contracts"."status" IN ('ACTIVE', 'TERMINATED', 'ANNULLED')),
	CONSTRAINT "contracts_status_reason" CHECK ("contracts"."status" = 'ACTIVE' OR ("contracts"."status_reason" IS NOT NULL AND btrim("contracts"."status_reason") <> '')),
	CONSTRAINT "contracts_number_not_blank" CHECK (btrim("contracts"."number") <> ''),
	CONSTRAINT "contracts_dates" CHECK ("contracts"."valid_to" IS NULL OR "contracts"."valid_to" >= "contracts"."valid_from"),
	CONSTRAINT "contracts_non_negative" CHECK ("contracts"."deferred_payment_days" >= 0
        AND coalesce("contracts"."advance_threshold_ex_vat", 0) >= 0
        AND coalesce("contracts"."advance_percent", 0) BETWEEN 0 AND 100
        AND coalesce("contracts"."penalty_rate_daily", 0) >= 0
        AND coalesce("contracts"."penalty_cap_percent", 0) BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "job_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"contragent_id" uuid NOT NULL,
	"contract_id" uuid,
	"contract_check" text NOT NULL,
	"contract_decision" text,
	"status" text DEFAULT 'QEBUL' NOT NULL,
	"formen_id" uuid NOT NULL,
	"mechanic_id" uuid,
	"complaints" text,
	"vin_snapshot" text,
	"plate_snapshot" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT (nullif(current_setting('app.user_id', true), ''))::uuid NOT NULL,
	CONSTRAINT "job_orders_number_unique" UNIQUE("number"),
	CONSTRAINT "job_orders_number_format" CHECK ("job_orders"."number" ~ '^IS-[0-9]{4}-[0-9]{6}$'),
	CONSTRAINT "job_orders_status" CHECK (status IN ('QEBUL', 'BAXIS', 'QIYMETLENDIRME', 'TESDIQ_GOZLEYIR', 'TESDIQLENDI', 'HISSE_GOZLEYIR', 'TEMIRDE', 'HAZIR', 'TEHVIL_VERILDI', 'ODENILDI', 'BAGLANDI', 'LEGV')),
	CONSTRAINT "job_orders_contract_check" CHECK (contract_check IN ('ON_CONTRACT', 'NOT_ON_CONTRACT', 'CONTRACT_EXPIRED', 'NO_CONTRACT')),
	CONSTRAINT "job_orders_contract_decision" CHECK (("job_orders"."contract_decision" IS NULL OR "job_orders"."contract_decision" IN ('SEPARATE_PAID', 'HOLD_FOR_MANAGEMENT'))
        AND (("job_orders"."contract_decision" IS NOT NULL) = ("job_orders"."contract_check" IN ('NOT_ON_CONTRACT', 'CONTRACT_EXPIRED')))),
	CONSTRAINT "job_orders_cancel_reason" CHECK (("job_orders"."status" = 'LEGV') = ("job_orders"."cancel_reason" IS NOT NULL AND btrim("job_orders"."cancel_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "job_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_status_events_to_status" CHECK (to_status IN ('QEBUL', 'BAXIS', 'QIYMETLENDIRME', 'TESDIQ_GOZLEYIR', 'TESDIQLENDI', 'HISSE_GOZLEYIR', 'TEMIRDE', 'HAZIR', 'TEHVIL_VERILDI', 'ODENILDI', 'BAGLANDI', 'LEGV')),
	CONSTRAINT "job_status_events_from_status" CHECK ("job_status_events"."from_status" IS NULL OR "job_status_events"."from_status" IN ('QEBUL', 'BAXIS', 'QIYMETLENDIRME', 'TESDIQ_GOZLEYIR', 'TESDIQLENDI', 'HISSE_GOZLEYIR', 'TEMIRDE', 'HAZIR', 'TEHVIL_VERILDI', 'ODENILDI', 'BAGLANDI', 'LEGV'))
);
--> statement-breakpoint
ALTER TABLE "contract_vehicles" ADD CONSTRAINT "contract_vehicles_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_vehicles" ADD CONSTRAINT "contract_vehicles_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_vehicles" ADD CONSTRAINT "contract_vehicles_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_vehicles" ADD CONSTRAINT "contract_vehicles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_contragent_id_contragents_id_fk" FOREIGN KEY ("contragent_id") REFERENCES "public"."contragents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_contragent_id_contragents_id_fk" FOREIGN KEY ("contragent_id") REFERENCES "public"."contragents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_formen_id_users_id_fk" FOREIGN KEY ("formen_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_mechanic_id_users_id_fk" FOREIGN KEY ("mechanic_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_events" ADD CONSTRAINT "job_status_events_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_events" ADD CONSTRAINT "job_status_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_vehicles_one_active_per_vehicle" ON "contract_vehicles" USING btree ("vehicle_id") WHERE "contract_vehicles"."removed_on" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_orders_one_open_per_vehicle" ON "job_orders" USING btree ("vehicle_id") WHERE "job_orders"."status" NOT IN ('BAGLANDI', 'LEGV');--> statement-breakpoint
ALTER TABLE "vehicle_plates" ADD CONSTRAINT "vehicle_plates_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_job_order_id_job_orders_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_orders"("id") ON DELETE no action ON UPDATE no action;
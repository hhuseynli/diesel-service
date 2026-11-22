DROP INDEX "job_orders_one_open_per_vehicle";--> statement-breakpoint
ALTER TABLE "job_orders" ADD COLUMN "car_released" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_orders_one_open_per_vehicle" ON "job_orders" USING btree ("vehicle_id") WHERE NOT "job_orders"."car_released" AND "job_orders"."status" NOT IN ('BAGLANDI', 'LEGV');
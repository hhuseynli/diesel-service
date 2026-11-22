import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { createdBy } from "./people";

// A vehicle is its VIN (spec 00, section 3a; R25). The check digit is not enforced (plan 01, F7).
export const vehicles = pgTable(
  "vehicles",
  {
    id: id(),
    vin: text("vin").notNull().unique(),
    make: text("make"),
    model: text("model"),
    year: smallint("year"),
    engine: text("engine"),
    // What the QR sticker encodes: random, never the VIN (R8).
    qrToken: text("qr_token")
      .notNull()
      .unique()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
    decodeSource: text("decode_source"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("vehicles_vin_format", sql`${t.vin} ~ '^[A-HJ-NPR-Z0-9]{17}$'`),
    check("vehicles_year_range", sql`${t.year} BETWEEN 1950 AND 2100`),
  ],
);

// Dated plate history: display and search only, never identity (spec 00, section 3a).
// The spec's recorded_by is created_by (plan 01, F12).
export const vehiclePlates = pgTable(
  "vehicle_plates",
  {
    id: id(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    plateDisplay: text("plate_display").notNull(),
    // Must stay in step with lib/vehicles/plates.ts normalizePlate().
    plateNormalized: text("plate_normalized")
      .notNull()
      .generatedAlwaysAs(sql`upper(regexp_replace(plate_display, '[[:space:]-]', '', 'g'))`),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    status: text("status").notNull(),
    source: text("source").notNull(),
    // Foreign key added with job_orders in milestone 2.
    jobOrderId: uuid("job_order_id"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("vehicle_plates_status", sql`${t.status} IN ('ACTIVE', 'ENDED', 'UNCONFIRMED')`),
    check("vehicle_plates_source", sql`${t.source} IN ('INTAKE', 'CONTRACT', 'IMPORT')`),
    check(
      "vehicle_plates_ended_has_valid_to",
      sql`(${t.status} = 'ENDED') = (${t.validTo} IS NOT NULL)`,
    ),
    check("vehicle_plates_dates", sql`${t.validTo} >= ${t.validFrom}`),
    check("vehicle_plates_display_length", sql`length(${t.plateDisplay}) BETWEEN 1 AND 20`),
    check("vehicle_plates_normalized_not_empty", sql`${t.plateNormalized} <> ''`),
    // At most one ACTIVE plate per vehicle, and one ACTIVE vehicle per plate (section 3a, rule 3).
    uniqueIndex("vehicle_plates_one_active_per_vehicle")
      .on(t.vehicleId)
      .where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex("vehicle_plates_one_active_per_plate")
      .on(t.plateNormalized)
      .where(sql`${t.status} = 'ACTIVE'`),
    index("vehicle_plates_search").using("btree", t.plateNormalized.op("text_pattern_ops")),
  ],
);

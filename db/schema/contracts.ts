import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { contragents } from "./contragents";
import { createdBy, users } from "./people";
import { vehicles } from "./vehicles";

// Service contracts with corporate clients (spec 00, section 3; plan 02).
// `number` is the client's paper contract number, not one of our document numbers.
// An auto-renewing contract stays valid past valid_to until terminated (plan 02, C1).
export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    contragentId: uuid("contragent_id")
      .notNull()
      .references(() => contragents.id),
    number: text("number").notNull(),
    signedOn: date("signed_on").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    autoRenew: boolean("auto_renew").notNull().default(false),
    deferredPaymentDays: integer("deferred_payment_days").notNull().default(0),
    advanceThresholdExVat: numeric("advance_threshold_ex_vat", { precision: 14, scale: 2 }),
    advancePercent: numeric("advance_percent", { precision: 5, scale: 2 }),
    // Used only by the on-request penalty calculation (R17).
    penaltyRateDaily: numeric("penalty_rate_daily", { precision: 7, scale: 4 }),
    penaltyCapPercent: numeric("penalty_cap_percent", { precision: 5, scale: 2 }),
    status: text("status").notNull().default("ACTIVE"),
    statusReason: text("status_reason"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    unique("contracts_contragent_number").on(t.contragentId, t.number),
    check("contracts_status", sql`${t.status} IN ('ACTIVE', 'TERMINATED', 'ANNULLED')`),
    check(
      "contracts_status_reason",
      sql`${t.status} = 'ACTIVE' OR (${t.statusReason} IS NOT NULL AND btrim(${t.statusReason}) <> '')`,
    ),
    check("contracts_number_not_blank", sql`btrim(${t.number}) <> ''`),
    check("contracts_dates", sql`${t.validTo} IS NULL OR ${t.validTo} >= ${t.validFrom}`),
    check(
      "contracts_non_negative",
      sql`${t.deferredPaymentDays} >= 0
        AND coalesce(${t.advanceThresholdExVat}, 0) >= 0
        AND coalesce(${t.advancePercent}, 0) BETWEEN 0 AND 100
        AND coalesce(${t.penaltyRateDaily}, 0) >= 0
        AND coalesce(${t.penaltyCapPercent}, 0) BETWEEN 0 AND 100`,
    ),
  ],
);

// The vehicles a contract covers, matched by VIN (vehicle_id). The plate written in the
// contract is kept for reference only (section 3a). Removal is dated, never deleted.
export const contractVehicles = pgTable(
  "contract_vehicles",
  {
    id: id(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    contractPlate: text("contract_plate"),
    addedOn: date("added_on")
      .notNull()
      .default(sql`baku_date()`),
    removedOn: date("removed_on"),
    removedBy: uuid("removed_by").references(() => users.id),
    removeReason: text("remove_reason"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check(
      "contract_vehicles_removed_together",
      sql`(${t.removedOn} IS NULL AND ${t.removedBy} IS NULL AND ${t.removeReason} IS NULL)
        OR (${t.removedOn} IS NOT NULL AND ${t.removedBy} IS NOT NULL AND btrim(${t.removeReason}) <> '')`,
    ),
    check("contract_vehicles_dates", sql`${t.removedOn} IS NULL OR ${t.removedOn} >= ${t.addedOn}`),
    // A car is on at most one active contract (plan 02, C2).
    uniqueIndex("contract_vehicles_one_active_per_vehicle")
      .on(t.vehicleId)
      .where(sql`${t.removedOn} IS NULL`),
  ],
);

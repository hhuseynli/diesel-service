import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  CONTRACT_CHECKS,
  CONTRACT_DECISIONS,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
} from "@/lib/jobs/types";
import { createdAt, id, oneOf, sqlList } from "./columns";
import { contracts } from "./contracts";
import { contragents } from "./contragents";
import { createdBy, users } from "./people";
import { vehicles } from "./vehicles";

// The visit: everything at the workshop attaches here (spec 00, section 3).
// The lifecycle is enforced by the job_orders_guard trigger (plan 02). The spec's
// opened_at is created_at (plan 02, C6). The snapshots are filled by the database.
export const jobOrders = pgTable(
  "job_orders",
  {
    id: id(),
    number: text("number").notNull().unique(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    contragentId: uuid("contragent_id")
      .notNull()
      .references(() => contragents.id),
    contractId: uuid("contract_id").references(() => contracts.id),
    contractCheck: text("contract_check").notNull(),
    contractDecision: text("contract_decision"),
    status: text("status").notNull().default("QEBUL"),
    formenId: uuid("formen_id")
      .notNull()
      .references(() => users.id),
    mechanicId: uuid("mechanic_id").references(() => users.id),
    complaints: text("complaints"),
    vinSnapshot: text("vin_snapshot"),
    plateSnapshot: text("plate_snapshot"),
    cancelReason: text("cancel_reason"),
    // The formen's answer to "Sahibi dəyişib?" when the client differs from the
    // vehicle's last job (spec 00, section 3a; plan 04, B7). Null when not asked.
    ownerChanged: boolean("owner_changed"),
    // Set by the database on handover (TEHVIL_VERILDI) and never unset: the car has left.
    carReleased: boolean("car_released").notNull().default(false),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("job_orders_number_format", sql`${t.number} ~ '^IS-[0-9]{4}-[0-9]{6}$'`),
    check("job_orders_status", oneOf("status", JOB_STATUSES)),
    check("job_orders_contract_check", oneOf("contract_check", CONTRACT_CHECKS)),
    check(
      "job_orders_contract_decision",
      sql`(${t.contractDecision} IS NULL OR ${t.contractDecision} IN (${sqlList(CONTRACT_DECISIONS)}))
        AND ((${t.contractDecision} IS NOT NULL) = (${t.contractCheck} IN ('NOT_ON_CONTRACT', 'CONTRACT_EXPIRED')))`,
    ),
    check(
      "job_orders_cancel_reason",
      sql`(${t.status} = 'LEGV') = (${t.cancelReason} IS NOT NULL AND btrim(${t.cancelReason}) <> '')`,
    ),
    // One job per car at the workshop (spec 01, section 3.2.3). A job handed over and
    // waiting for deferred payment no longer holds the car (plan 02, F23).
    uniqueIndex("job_orders_one_open_per_vehicle")
      .on(t.vehicleId)
      .where(sql`NOT ${t.carReleased} AND ${t.status} NOT IN (${sqlList(TERMINAL_JOB_STATUSES)})`),
  ],
);

// Every status change, written by the job_status_event trigger, never by the app.
// Append-only like audit_log: the app role can only read it.
export const jobStatusEvents = pgTable(
  "job_status_events",
  {
    id: id(),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .references(() => jobOrders.id),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // Orders events within one transaction, where `at` (now()) is the same.
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
  },
  (t) => [
    check("job_status_events_to_status", oneOf("to_status", JOB_STATUSES)),
    check(
      "job_status_events_from_status",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} IN (${sqlList(JOB_STATUSES)})`,
    ),
  ],
);

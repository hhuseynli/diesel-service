import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { createdBy } from "./people";

// One record can be both customer and supplier (spec 00, section 3).
export const contragents = pgTable(
  "contragents",
  {
    id: id(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    voen: text("voen"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    bankDetails: jsonb("bank_details"),
    isCustomer: boolean("is_customer").notNull().default(false),
    isSupplier: boolean("is_supplier").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("contragents_kind", sql`${t.kind} IN ('FIZIKI', 'HUQUQI')`),
    check("contragents_name_not_blank", sql`btrim(${t.name}) <> ''`),
    check("contragents_voen_format", sql`${t.voen} ~ '^[0-9]{10}$'`),
    check("contragents_customer_or_supplier", sql`${t.isCustomer} OR ${t.isSupplier}`),
    uniqueIndex("contragents_voen_unique")
      .on(t.voen)
      .where(sql`${t.voen} IS NOT NULL`),
  ],
);

// Staff created in the e2e database by e2e/prepare-db.ts. Not real people.
export const E2E_DB = "diesel_e2e";

export const CASHIER = { name: "E2E Kassir", phone: "+994509990001", password: "kassa-e2e-sifre" };
export const MANAGER = {
  name: "E2E Rəhbər",
  phone: "+994509990002",
  password: "rehber-e2e-sifre",
  totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
};
export const FORMEN = { name: "E2E Formen", phone: "+994509990003", pin: "4821" };
/** No sign-in: the tablet spec acts for them through lib (their screens come later). */
export const WAREHOUSE = { name: "E2E Anbardar", phone: "+994509990004" };
export const MECHANIC = { name: "E2E Təmirçi", phone: "+994509990005" };

/** Tablet sessions lock after this many idle seconds in the e2e database. */
export const IDLE_SECONDS = 3;

/** The same server and credentials as `url`, another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

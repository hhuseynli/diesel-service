// Staff roles (spec 00, section 10). Mechanic exists but has no permissions until tablets arrive (R3).
export const ROLES = [
  "OWNER",
  "MANAGEMENT",
  "FORMEN",
  "WAREHOUSEMAN",
  "CASHIER",
  "BOOKKEEPER",
  "MECHANIC",
] as const;
export type Role = (typeof ROLES)[number];

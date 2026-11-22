// Document types and statuses (spec 00, section 3). Shared by the schema and lib code.

export const DOC_TYPES = [
  "QUSUR_AKTI",
  "ELAVE_AKT",
  "QIYMET_PROTOKOLU",
  "TEHVIL_TESLIM",
  "SATIS",
  "ALIS",
  "MEDAXIL",
  "MEXARIC",
  "SILINME",
  "INVENTAR",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "REJECTED",
  "APPROVED",
  "POSTED",
  "ANNULLED",
] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

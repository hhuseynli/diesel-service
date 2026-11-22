// Job order lifecycle (spec 00, section 4; plan 02). Shared by the schema and lib code.

export const JOB_STATUSES = [
  "QEBUL",
  "BAXIS",
  "QIYMETLENDIRME",
  "TESDIQ_GOZLEYIR",
  "TESDIQLENDI",
  "HISSE_GOZLEYIR",
  "TEMIRDE",
  "HAZIR",
  "TEHVIL_VERILDI",
  "ODENILDI",
  "BAGLANDI",
  "LEGV",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES = ["BAGLANDI", "LEGV"] as const;

/** Result of the intake contract check (spec 01, section 3.3). */
export const CONTRACT_CHECKS = [
  "ON_CONTRACT",
  "NOT_ON_CONTRACT",
  "CONTRACT_EXPIRED",
  "NO_CONTRACT",
] as const;
export type ContractCheck = (typeof CONTRACT_CHECKS)[number];

/** The formen's choice when the check warns (plan 02, C3). */
export const CONTRACT_DECISIONS = ["SEPARATE_PAID", "HOLD_FOR_MANAGEMENT"] as const;
export type ContractDecision = (typeof CONTRACT_DECISIONS)[number];

import type { DocType } from "@/lib/documents/types";

/** Everything that gets a gapless number: document types and job orders (plan 02, C5). */
export type NumberSeries = DocType | "JOB_ORDER";

// Printed on legal documents. Proposed in plan 01 (open item O2); confirm before
// the first real document, after which a prefix can no longer change.
export const PREFIXES: Record<NumberSeries, string> = {
  QUSUR_AKTI: "QA",
  ELAVE_AKT: "EA",
  QIYMET_PROTOKOLU: "QP",
  TEHVIL_TESLIM: "TT",
  SATIS: "ST",
  ALIS: "AL",
  MEDAXIL: "MD",
  MEXARIC: "MX",
  SILINME: "SL",
  INVENTAR: "IN",
  // İş sifarişi (job order).
  JOB_ORDER: "IS",
};

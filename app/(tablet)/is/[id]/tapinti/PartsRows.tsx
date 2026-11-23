"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/app/_ui/Icon";

/** Parts requests as free text (name, quantity, unit); the warehouse finds the codes. */
export function PartsRows() {
  const t = useTranslations("job");
  const [rows, setRows] = useState(1);
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="parts-row">
          <input className="input" name="partName" aria-label={t("part")} />
          <input
            className="input num"
            name="partQty"
            aria-label={t("qty")}
            inputMode="decimal"
            defaultValue="1"
          />
          <input className="input" name="partUnit" aria-label={t("unit")} />
        </div>
      ))}
      <button type="button" className="btn flush" onClick={() => setRows((n) => n + 1)}>
        <Icon name="plus" />
        {t("addPartRow")}
      </button>
    </>
  );
}

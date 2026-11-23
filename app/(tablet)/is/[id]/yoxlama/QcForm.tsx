"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/app/_ui/Icon";
import { qualityCheckAction } from "../../../actions";

/**
 * 5.3 Keyfiyyət yoxlaması: "Uğurlu: Hazır et" waits for every item on the list;
 * "Uğursuz: təmirdə qalsın" records a failed check and the car stays in work.
 */
export function QcForm({
  jobId,
  items,
  left,
  right,
}: {
  jobId: string;
  items: { key: string; label: string }[];
  left: ReactNode;
  right: ReactNode;
}) {
  const t = useTranslations("job");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const done = items.filter((i) => checked[i.key]).length;
  const all = done === items.length;
  return (
    <form action={qualityCheckAction} className="main" style={{ ["--side" as string]: "440px" }}>
      <input type="hidden" name="jobId" value={jobId} />
      <section className="panel" style={{ gap: 10 }}>
        <span className="h-panel">{t("qcList")}</span>
        {items.map((i) => (
          <label key={i.key} className="check">
            <input
              type="checkbox"
              name="items"
              value={i.key}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setChecked((s) => ({ ...s, [i.key]: on }));
              }}
            />
            <span className="check-box" aria-hidden="true">
              <Icon name="check" size={20} stroke={2.4} />
            </span>
            {i.label}
          </label>
        ))}
        {left}
      </section>
      <section className="panel">
        {right}
        <span className="spacer" />
        <button
          type="submit"
          name="result"
          value="pass"
          className={all ? "btn primary lg block" : "btn lg block"}
          disabled={!all}
        >
          <Icon name="check" stroke={2.4} />
          {t("qcPass")}
        </button>
        {!all && (
          <span className="small muted center">{t("qcNotAll", { total: items.length, done })}</span>
        )}
        <button type="submit" name="result" value="fail" className="btn danger-outline lg block">
          {t("qcFail")}
        </button>
      </section>
    </form>
  );
}

import { useTranslations } from "next-intl";
import { Icon } from "./Icon";

const STEPS = ["vehicle", "client", "photos", "confirm"] as const;

/** The intake's four steps: 1. Maşın · 2. Müştəri · 3. Foto və yürüş · 4. Şikayət və imza. */
export function StepBar({ step }: { step: 1 | 2 | 3 | 4 }) {
  const t = useTranslations("intake.steps");
  return (
    <ol className="steps" aria-label={t("label")}>
      {STEPS.map((key, i) => {
        const n = i + 1;
        const state = n < step ? "step done" : n === step ? "step current" : "step";
        return (
          <li key={key} className={state} aria-current={n === step ? "step" : undefined}>
            <span>
              {n < step && <Icon name="check" size={14} stroke={2.6} />}
              {t(key, { n })}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

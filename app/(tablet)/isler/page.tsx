import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getDb } from "@/lib/db/client";
import { boardCards } from "@/lib/intake/queries";
import type { JobStatus } from "@/lib/jobs/types";

// The job board (spec 01, 3.1): open jobs by status, oldest first; a card turns amber
// after `job_board_amber_hours` in the same status.

const COLUMNS: JobStatus[] = [
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
];

export default async function BoardPage() {
  const t = await getTranslations("board");
  const ts = await getTranslations("status");
  const cards = await boardCards(getDb());
  return (
    <main>
      <h1>{t("title")}</h1>
      <Link href="/qebul" className="primary">
        {t("receive")}
      </Link>
      <div className="board">
        {COLUMNS.map((status) => {
          const inColumn = cards.filter((c) => c.status === status);
          return (
            <section key={status} aria-label={ts(status)}>
              <h2>{ts(status)}</h2>
              {inColumn.length === 0 && <p className="muted">{t("empty")}</p>}
              {inColumn.map((c) => (
                <Link
                  key={c.id}
                  href={`/is/${c.id}`}
                  className={c.amber ? "card amber" : "card"}
                  data-testid="job-card"
                >
                  <strong>{c.number}</strong>
                  <span>{[c.make, c.model].filter(Boolean).join(" ")}</span>
                  <span>{c.plate ?? c.vinLast6}</span>
                  <span>{c.client}</span>
                  <span>{c.mechanic ?? t("noMechanic")}</span>
                  <span className="muted">{t("waiting", { hours: c.hoursInStatus })}</span>
                </Link>
              ))}
            </section>
          );
        })}
      </div>
    </main>
  );
}

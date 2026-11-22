import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Icon } from "@/app/_components/Icon";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { boardCards } from "@/lib/intake/queries";
import type { JobStatus } from "@/lib/jobs/types";
import { Plate } from "../Plate";

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
  "ODENILDI",
];

export default async function BoardPage() {
  await requireSessionUser();
  const t = await getTranslations("board");
  const ts = await getTranslations("status");
  const cards = await boardCards(getDb());
  const columns = COLUMNS.map((status) => ({
    status,
    cards: cards.filter((c) => c.status === status),
  }));

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="muted">{t("openCount", { count: cards.length })}</p>
        </div>
        <Link href="/qebul" className="btn primary large">
          <Icon name="plus" />
          {t("receive")}
        </Link>
      </div>

      <nav className="chips" aria-label={t("summary")}>
        {columns.map(({ status, cards: inColumn }) => (
          <a
            key={status}
            href={`#${status}`}
            className={`chip st-${status}${inColumn.length ? "" : " empty"}`}
          >
            <span className="dot" aria-hidden="true" />
            {ts(status)}
            <span className="count">{inColumn.length}</span>
          </a>
        ))}
      </nav>

      {cards.length === 0 && (
        <div className="empty-state">
          <Icon name="truck" size={40} />
          <p>{t("noJobs")}</p>
        </div>
      )}

      {columns.map(({ status, cards: inColumn }) => (
        <section key={status} id={status} aria-label={ts(status)} className="lane">
          {inColumn.length > 0 && (
            <h2 className={`lane-head st-${status}`}>
              <span className="dot" aria-hidden="true" />
              {ts(status)}
              <span className="count">{inColumn.length}</span>
            </h2>
          )}
          <div className="card-grid">
            {inColumn.map((c) => (
              <Link
                key={c.id}
                href={`/is/${c.id}`}
                className={`job-card st-${c.status}${c.amber ? " late" : ""}`}
                data-testid="job-card"
              >
                <div className="job-card-top">
                  <span className="mono muted">{c.number}</span>
                  <span className={c.amber ? "time late" : "time"}>
                    <Icon name="clock" size={14} />
                    {t("hours", { hours: c.hoursInStatus })}
                  </span>
                </div>
                <strong className="job-card-title">
                  {[c.make, c.model].filter(Boolean).join(" ") || c.vinLast6}
                </strong>
                <div className="job-card-ids">
                  {c.plate && <Plate value={c.plate} />}
                  <span className="mono vin6">{c.vinLast6}</span>
                </div>
                <div className="job-card-meta">
                  <span>
                    <Icon name="user" size={16} />
                    {c.client}
                  </span>
                  <span className={c.mechanic ? undefined : "muted"}>
                    <Icon name="wrench" size={16} />
                    {c.mechanic ?? t("noMechanic")}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Duration } from "@/app/_ui/Duration";
import { Icon } from "@/app/_ui/Icon";
import { Plate } from "@/app/_ui/Plate";
import { StatusBadge } from "@/app/_ui/StatusBadge";
import { TabletBar } from "@/app/_ui/TabletBar";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { boardCards } from "@/lib/intake/queries";
import type { JobStatus } from "@/lib/jobs/types";

// The job board (spec 01, 3.1; design 1.4): five lanes by status family, cards longest
// waiting first; a card waiting longer than `job_board_amber_hours` turns amber.

const LANES: { key: "intake" | "office" | "waiting" | "work" | "ready"; codes: JobStatus[] }[] = [
  { key: "intake", codes: ["QEBUL"] },
  { key: "office", codes: ["BAXIS", "QIYMETLENDIRME"] },
  { key: "waiting", codes: ["TESDIQ_GOZLEYIR", "HISSE_GOZLEYIR"] },
  { key: "work", codes: ["TESDIQLENDI", "TEMIRDE"] },
  { key: "ready", codes: ["HAZIR", "ODENILDI"] },
];

export default async function BoardPage() {
  await requireSessionUser();
  const t = await getTranslations("board");
  const ts = await getTranslations("status");
  const cards = await boardCards(getDb());

  return (
    <>
      <TabletBar>
        <Link href="/qebul" className="btn primary">
          <Icon name="qr" size={24} />
          {t("receive")}
        </Link>
        <Link href="/qebul?m=vin" className="btn outline">
          <Icon name="plus" />
          {t("newCar")}
        </Link>
      </TabletBar>
      <main className="board">
        {LANES.map((lane) => {
          const inLane = cards.filter((c) => lane.codes.includes(c.status));
          return (
            <section key={lane.key} className="lane" aria-label={t(`lanes.${lane.key}`)}>
              <div className="lane-head">
                <span className="lane-title">
                  <h2>{t(`lanes.${lane.key}`)}</h2>
                  <span className="count">{inLane.length}</span>
                </span>
                {lane.codes.length > 1 && (
                  <span className="lane-sub">
                    {lane.codes.map((code) => (
                      <span key={code} data-testid={`count-${code}`}>
                        {ts(code)}
                        <b>{inLane.filter((c) => c.status === code).length}</b>
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className="lane-cards">
                {inLane.length === 0 && <span className="lane-empty">{t("laneEmpty")}</span>}
                {inLane.map((c) => (
                  <Link
                    key={c.id}
                    href={`/is/${c.id}`}
                    className={c.late ? "jcard late" : "jcard"}
                    data-testid="job-card"
                    data-status={c.status}
                  >
                    <span className="jcard-title">
                      {[c.make, c.model].filter(Boolean).join(" ") || c.client}
                    </span>
                    <Plate plate={c.plate} vin={c.vinLast6} size="sm" />
                    <span className="jcard-row">
                      <span>
                        <Icon name="wrench" size={14} />
                        <span className="ellipsis">{c.mechanic ?? t("noMechanic")}</span>
                      </span>
                      <span className="jcard-time" title={c.late ? t("late") : undefined}>
                        {c.late && <Icon name="warn" size={14} stroke={2.4} />}
                        <Duration minutes={c.minutesInStatus} />
                      </span>
                    </span>
                    <span className="jcard-row">
                      <span className="jcard-no">{c.number}</span>
                      <StatusBadge status={c.status} size="sm" />
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </main>
    </>
  );
}

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { StepBar } from "@/app/_ui/StepBar";
import { TabletBar } from "@/app/_ui/TabletBar";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/db/uuid";
import { formatDate } from "@/lib/format";
import { lastReading, vehicleSummary } from "@/lib/intake/queries";
import { getSetting } from "@/lib/settings";
import { ClientStep } from "./ClientStep";
import { ComplaintsStep } from "./ComplaintsStep";
import { Identify } from "./Identify";
import { NewVehicle } from "./NewVehicle";
import { href, type Params } from "./params";
import { PhotosForm } from "./PhotosForm";
import { VinCheck } from "./VinCheck";

// Receiving a car (spec 01, 3.2-3.5; design 2.1-3.3), one step per screen, the step kept
// in the URL (./params.ts). Nothing is written to the job until "Saxla" (saveIntake).

export default async function IntakePage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireSessionUser();
  const params = await searchParams;

  if (params.nv) return <NewVehicle params={params} />;
  if (!params.v) return <Identify params={params} />;
  if (!isUuid(params.v)) notFound();
  const db = getDb();
  const vehicle = await vehicleSummary(db, params.v);
  if (!vehicle) notFound();

  if (params.ok !== "1" || vehicle.openJobId) {
    return <VinCheck params={params} vehicle={vehicle} />;
  }
  if (params.go !== "1" || !isUuid(params.c)) {
    return <ClientStep params={params} vehicle={vehicle} />;
  }
  if (!params.p) {
    const t = await getTranslations("intake");
    const tu = await getTranslations("ui");
    const previous = await lastReading(db, vehicle.id);
    const maxPerDay = (await getSetting<number>(db, "odometer_max_km_per_day")) ?? 1000;
    const now = new Date().getTime();
    return (
      <>
        <TabletBar
          back={{ href: href(params, { go: undefined }), label: tu("back") }}
          title={t("title")}
        />
        <StepBar step={3} />
        <PhotosForm
          back={href(params)}
          previous={
            previous
              ? {
                  km: previous.km,
                  date: formatDate(previous.at),
                  // Whole days since that reading, at least one (as the database counts them).
                  days: Math.max(
                    1,
                    Math.ceil((now - new Date(previous.at).getTime()) / 86_400_000),
                  ),
                }
              : null
          }
          maxPerDay={maxPerDay}
        />
      </>
    );
  }
  return <ComplaintsStep params={params} />;
}

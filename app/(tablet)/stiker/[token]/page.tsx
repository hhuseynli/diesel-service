import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Plate } from "@/app/_ui/Plate";
import { PrintButton } from "@/app/_ui/PrintButton";
import { TabletBar } from "@/app/_ui/TabletBar";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { findByQrToken } from "@/lib/intake";
import { vehicleSummary } from "@/lib/intake/queries";

// 2.4 QR stiker (plan 04, B4): one 50x30 mm label carrying the QR code only, no vehicle or
// personal data (spec 01, section 4; R8). The code holds the URL /q/<token>; the car is
// shown on screen so the formen sticks the label on the right one.

async function appOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

/** Back to the job card or the intake step that opened the sticker, never elsewhere. */
function safeBack(back: string | undefined): string {
  if (back && /^\/is\/[0-9a-f-]{36}$/.test(back)) return back;
  if (back && /^\/qebul\?[\w=&%.+-]*$/.test(back)) return back;
  return "/isler";
}

export default async function StickerPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ back?: string }>;
}) {
  await requireSessionUser();
  const { token } = await params;
  const back = safeBack((await searchParams).back);
  const db = getDb();
  const found = await findByQrToken(db, token);
  if (!found || found.replaced) notFound();
  const vehicle = await vehicleSummary(db, found.vehicleId);
  if (!vehicle) notFound();
  const t = await getTranslations("sticker");
  const tu = await getTranslations("ui");
  const svg = await QRCode.toString(`${await appOrigin()}/q/${token}`, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
  });
  return (
    <>
      <TabletBar back={{ href: back, label: tu("back") }} title={t("title")} />
      <main className="main">
        <section className="sticker-stage">
          <div className="sticker" data-testid="sticker">
            <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
          <span className="muted no-print">{t("preview")}</span>
        </section>
        <section className="panel no-print">
          <h1 className="h-card">{t("onlyQr")}</h1>
          <p className="muted">{t("onlyQrBody")}</p>
          <span className="job-vehicle">
            <strong>
              {[vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicle.vin}
            </strong>
          </span>
          <Plate plate={vehicle.plate} vin={vehicle.vin} />
          <span className="spacer" />
          <PrintButton label={t("print")} />
          <Link className="btn block" href={back}>
            {t("continue")}
          </Link>
        </section>
      </main>
    </>
  );
}

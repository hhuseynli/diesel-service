import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { PrintButton } from "@/app/_components/PrintButton";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { findByQrToken } from "@/lib/intake";
import { vehicleSummary } from "@/lib/intake/queries";
import { Plate } from "../../Plate";

// The QR sticker print page (plan 04, B4): one 50x30 mm label. The label carries the QR
// code only, no vehicle or personal data (spec 01, section 4; R8). The code holds the URL
// /q/<token>; the car is shown on screen so the formen sticks it on the right one.

async function appOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

export default async function StickerPage({ params }: { params: Promise<{ token: string }> }) {
  await requireSessionUser();
  const { token } = await params;
  const db = getDb();
  const found = await findByQrToken(db, token);
  if (!found || found.replaced) notFound();
  const vehicle = await vehicleSummary(db, found.vehicleId);
  if (!vehicle) notFound();
  const t = await getTranslations("sticker");
  const svg = await QRCode.toString(`${await appOrigin()}/q/${token}`, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
  });
  return (
    <main>
      <div className="page-head no-print">
        <div>
          <h1>{t("title")}</h1>
          <p className="muted">
            {[vehicle.make, vehicle.model].filter(Boolean).join(" ")}{" "}
            <span className="mono">{vehicle.vin}</span>
          </p>
        </div>
        {vehicle.plate && <Plate value={vehicle.plate} />}
      </div>
      <section className="card sticker-preview">
        <div className="sticker" data-testid="sticker">
          <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
        <PrintButton label={t("print")} />
      </section>
    </main>
  );
}

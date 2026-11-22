import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { PrintButton } from "@/app/_components/PrintButton";
import { getDb } from "@/lib/db/client";
import { findByQrToken } from "@/lib/intake";
import { vehicleSummary } from "@/lib/intake/queries";

// The QR sticker print page (plan 04, B4): one 50x30 mm label. The code holds the URL
// /q/<token>, so any phone camera opens the car; the tablet scanner reads the token.

async function appOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

export default async function StickerPage({ params }: { params: Promise<{ token: string }> }) {
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
      <h1 className="no-print">{t("title")}</h1>
      <div className="sticker" data-testid="sticker">
        <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div>
          <strong>{vehicle.plate ?? vehicle.vin.slice(-6)}</strong>
          <span>{vehicle.vin}</span>
        </div>
      </div>
      <PrintButton label={t("print")} />
    </main>
  );
}

import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { findByQrToken } from "@/lib/intake";

// What a sticker's QR code opens (spec 01, section 4): the car's intake screen, which
// shows its open job if there is one. Signed-out visitors go to sign-in.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!(await getSessionUser())) redirect("/");
  const { token } = await params;
  const found = await findByQrToken(getDb(), token);
  if (!found) redirect("/qebul?e=notFound");
  redirect(`/qebul?v=${found.vehicleId}${found.replaced ? "&rs=1" : ""}`);
}

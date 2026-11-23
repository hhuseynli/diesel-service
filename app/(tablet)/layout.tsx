import type { ReactNode } from "react";
import { requireSessionUser } from "@/lib/auth/context";

// The formen's tablet screens (plan 04, B12; design canvas "Planşet (formen)"): landscape
// 1280x800, each screen with its own bar. Every page checks the session itself as well
// (Next renders a page in parallel with its layout); actions check permissions again.
export default async function TabletLayout({ children }: { children: ReactNode }) {
  await requireSessionUser();
  return <div className="screen">{children}</div>;
}

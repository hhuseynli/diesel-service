import { notFound } from "next/navigation";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/db/uuid";
import { jobCard, mechanics } from "@/lib/intake/queries";

/** The job and the mechanics for a job-card sub-screen, signed in, or 404. */
export async function loadJob(params: Promise<{ id: string }>) {
  await requireSessionUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const db = getDb();
  const job = await jobCard(db, id);
  if (!job) notFound();
  return { job, staff: await mechanics(db) };
}

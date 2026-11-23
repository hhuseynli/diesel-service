import { sql } from "drizzle-orm";
import { attachments } from "@/db/schema";
import type { Tx } from "@/lib/db/types";
import { exifCaptureTime } from "@/lib/files/exif";
import { getFileStore, type FileStore } from "@/lib/files";

// Storing a photo or scan: the bytes in the file store, the key and hash in `attachments`
// (spec 00, section 8; plan 04, B1-B2). Rows are never updated (forbid_update).

export type CaptureCheck = "CAMERA_OK" | "CAPTURE_TIME_OFF" | "NO_CAPTURE_TIME";

/** Ten minutes either way between the photo's own time and the server's (Asia/Baku). */
const CAPTURE_TOLERANCE_SECONDS = 600;

export async function storeAttachment(
  tx: Tx,
  file: { bytes: Uint8Array; mimeType: string },
  store: FileStore = getFileStore(),
): Promise<{ id: string; captureCheck: CaptureCheck }> {
  const stored = await store.put(file.bytes, file.mimeType);
  const captureTime = file.mimeType === "image/jpeg" ? exifCaptureTime(file.bytes) : null;
  // The camera writes local time without a zone; the tablet is in Baku.
  const { rows } = await tx.execute<{ check: CaptureCheck }>(sql`
    SELECT CASE
      WHEN ${captureTime}::text IS NULL THEN 'NO_CAPTURE_TIME'
      WHEN abs(extract(epoch FROM (now() AT TIME ZONE 'Asia/Baku')
                 - to_timestamp(${captureTime}, 'YYYY:MM:DD HH24:MI:SS')::timestamp))
           <= ${CAPTURE_TOLERANCE_SECONDS} THEN 'CAMERA_OK'
      ELSE 'CAPTURE_TIME_OFF'
    END AS check`);
  const captureCheck = rows[0]!.check;
  const [row] = await tx
    .insert(attachments)
    .values({
      storageKey: stored.storageKey,
      sha256: stored.sha256,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      captureTime,
      captureCheck,
    })
    .onConflictDoNothing({ target: attachments.storageKey })
    .returning({ id: attachments.id });
  if (row) return { id: row.id, captureCheck };
  // The same bytes were uploaded before (a retried upload): reuse that row.
  const { rows: existing } = await tx.execute<{ id: string; capture_check: CaptureCheck }>(
    sql`SELECT id, capture_check FROM attachments WHERE storage_key = ${stored.storageKey}`,
  );
  return { id: existing[0]!.id, captureCheck: existing[0]!.capture_check };
}

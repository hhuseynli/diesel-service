import { eq } from "drizzle-orm";
import { attachments } from "@/db/schema";
import { getSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { getFileStore } from "@/lib/files";
import { isUuid } from "@/lib/db/uuid";

// A stored photo, video or signature, for signed-in staff only (spec 00, section 8).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionUser())) return new Response(null, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return new Response(null, { status: 404 });
  const [file] = await getDb()
    .select({ storageKey: attachments.storageKey, mimeType: attachments.mimeType })
    .from(attachments)
    .where(eq(attachments.id, id));
  if (!file) return new Response(null, { status: 404 });
  const bytes = await getFileStore().get(file.storageKey);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": file.mimeType,
      // Content-addressed and never changed, but private to the signed-in user.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

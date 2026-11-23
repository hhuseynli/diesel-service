import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exifCaptureTime } from "./exif";
import { FileRejectedError, LocalFileStore, sha256Hex } from "./index";

/** A minimal JPEG: SOI, an APP1 EXIF block with DateTimeOriginal, EOI. */
function jpegWithCaptureTime(when: string, little = true): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) =>
    little
      ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24]
      : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  // Header: byte order, 42, offset of IFD0 (8).
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  // IFD0 at 8: one entry, the EXIF IFD pointer -> 26.
  tiff.push(...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(26), ...u32(0));
  // EXIF IFD at 26: one entry, DateTimeOriginal (ASCII, 20 bytes) at 44.
  tiff.push(...u16(1), ...u16(0x9003), ...u16(2), ...u32(20), ...u32(44), ...u32(0));
  tiff.push(...Array.from(when).map((c) => c.charCodeAt(0)), 0);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = app1.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 255, ...app1, 0xff, 0xd9]);
}

describe("exifCaptureTime", () => {
  it("reads DateTimeOriginal in both byte orders", () => {
    expect(exifCaptureTime(jpegWithCaptureTime("2026:11:22 14:05:09"))).toBe("2026:11:22 14:05:09");
    expect(exifCaptureTime(jpegWithCaptureTime("2026:11:22 14:05:09", false))).toBe(
      "2026:11:22 14:05:09",
    );
  });

  it("returns null without EXIF or for other formats", () => {
    expect(exifCaptureTime(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(exifCaptureTime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(exifCaptureTime(new Uint8Array())).toBeNull();
  });

  it("never throws: a cut-off file or an impossible date gives null (B2: it never blocks)", () => {
    const whole = jpegWithCaptureTime("2026:11:22 14:05:09");
    // The APP1 block claims more bytes than the file has.
    for (const cut of [8, 16, 30, 50, whole.length - 10]) {
      expect(exifCaptureTime(whole.slice(0, cut))).toBeNull();
    }
    expect(exifCaptureTime(jpegWithCaptureTime("2026:02:30 10:00:00"))).toBeNull();
    expect(exifCaptureTime(jpegWithCaptureTime("2026:11:22 25:00:00"))).toBeNull();
    expect(exifCaptureTime(jpegWithCaptureTime("0000:00:00 00:00:00"))).toBeNull();
  });
});

describe("LocalFileStore", () => {
  it("stores by hash, returns the same bytes, and never overwrites", async () => {
    const store = new LocalFileStore(await mkdtemp(path.join(tmpdir(), "files-")));
    const bytes = jpegWithCaptureTime("2026:11:22 10:00:00");
    const stored = await store.put(bytes, "image/jpeg");
    expect(stored).toEqual({
      storageKey: sha256Hex(bytes),
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.length,
      mimeType: "image/jpeg",
    });
    expect(await store.put(bytes, "image/jpeg")).toEqual(stored);
    expect(Buffer.from(await store.get(stored.storageKey))).toEqual(Buffer.from(bytes));
  });

  it("refuses other types, empty and oversized files, and invalid keys", async () => {
    const store = new LocalFileStore(await mkdtemp(path.join(tmpdir(), "files-")));
    await expect(store.put(Uint8Array.from([1]), "text/html")).rejects.toBeInstanceOf(
      FileRejectedError,
    );
    await expect(store.put(new Uint8Array(), "image/png")).rejects.toBeInstanceOf(
      FileRejectedError,
    );
    await expect(store.put(new Uint8Array(16 * 1024 * 1024), "image/png")).rejects.toBeInstanceOf(
      FileRejectedError,
    );
    await expect(store.get("../../etc/passwd")).rejects.toBeInstanceOf(FileRejectedError);
  });

  it("refuses a file whose contents are not the type it claims", async () => {
    const store = new LocalFileStore(await mkdtemp(path.join(tmpdir(), "files-")));
    const pdf = new TextEncoder().encode("%PDF-1.7 not a photo");
    await expect(store.put(pdf, "image/jpeg")).rejects.toBeInstanceOf(FileRejectedError);
    await expect(store.put(pdf, "application/pdf")).resolves.toMatchObject({
      mimeType: "application/pdf",
    });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    await expect(store.put(png, "image/png")).resolves.toMatchObject({ mimeType: "image/png" });
    await expect(store.put(png, "image/jpeg")).rejects.toBeInstanceOf(FileRejectedError);
  });
});

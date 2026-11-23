// Reads DateTimeOriginal from a JPEG's EXIF block (plan 04, B2). A browser cannot prove a
// photo came from the camera; the capture time, compared with the server's time at
// upload, is recorded as evidence (R2). Returns "YYYY:MM:DD HH:MM:SS" or null. It never
// throws: a cut-off file or a camera with a bad clock gives null, and the upload goes on.

const DATE_TIME_ORIGINAL = 0x9003;
const EXIF_IFD_POINTER = 0x8769;

export function exifCaptureTime(bytes: Uint8Array): string | null {
  try {
    const text = findCaptureTime(bytes);
    return text !== null && isRealDateTime(text) ? text : null;
  } catch {
    // Offsets pointing past the end of a cut-off file.
    return null;
  }
}

/** "2026:02:30 10:00:00" or "...25:00:00" pass the pattern but are not real times. */
function isRealDateTime(text: string): boolean {
  const [y, mo, d, h, mi, s] = text.split(/[: ]/).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === s
  );
}

function findCaptureTime(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = view.getUint16(offset + 2);
    if (marker === 0xda || marker === 0xd9) return null; // image data: no EXIF before it
    if (marker === 0xe1 && isExifHeader(bytes, offset + 4)) {
      return readTiff(bytes, view, offset + 10, offset + 2 + length);
    }
    offset += 2 + length;
  }
  return null;
}

function isExifHeader(bytes: Uint8Array, at: number): boolean {
  return String.fromCharCode(...bytes.slice(at, at + 4)) === "Exif" && bytes[at + 4] === 0;
}

function readTiff(bytes: Uint8Array, view: DataView, start: number, end: number): string | null {
  if (start + 8 > end) return null;
  const little = view.getUint16(start) === 0x4949;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);

  const findTag = (ifdOffset: number, tag: number): number | null => {
    const ifd = start + ifdOffset;
    if (ifd + 2 > end) return null;
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > end) return null;
      if (u16(entry) === tag) return entry;
    }
    return null;
  };

  const exifPointer = findTag(u32(start + 4), EXIF_IFD_POINTER);
  if (exifPointer === null) return null;
  const dateEntry = findTag(u32(exifPointer + 8), DATE_TIME_ORIGINAL);
  if (dateEntry === null) return null;
  const valueAt = start + u32(dateEntry + 8);
  if (valueAt + 19 > end) return null;
  const text = String.fromCharCode(...bytes.slice(valueAt, valueAt + 19));
  return /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text : null;
}

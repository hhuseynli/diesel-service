import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Photos and scans (spec 00, section 8; plan 04, B1). Files are stored by their SHA-256,
// never overwritten or deleted; the database keeps the key and the hash. Local disk in
// development; cloud object storage replaces this adapter once hosting is decided (D2, R20).

export const ALLOWED_TYPES: Record<string, number> = {
  "image/jpeg": 15 * 1024 * 1024,
  "image/png": 15 * 1024 * 1024,
  "image/webp": 15 * 1024 * 1024,
  // Findings may be a short video (spec 01, section 3.6).
  "video/mp4": 60 * 1024 * 1024,
  "application/pdf": 15 * 1024 * 1024,
};

export interface StoredFile {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

export interface FileStore {
  put(bytes: Uint8Array, mimeType: string): Promise<StoredFile>;
  get(storageKey: string): Promise<Uint8Array>;
}

export class FileRejectedError extends Error {}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** How each accepted type begins; the type the browser declares is not trusted alone. */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "image/jpeg": (b) => starts(b, 0, [0xff, 0xd8, 0xff]),
  "image/png": (b) => starts(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": (b) =>
    starts(b, 0, [0x52, 0x49, 0x46, 0x46]) && starts(b, 8, [0x57, 0x45, 0x42, 0x50]),
  "video/mp4": (b) => starts(b, 4, [0x66, 0x74, 0x79, 0x70]), // "ftyp"
  "application/pdf": (b) => starts(b, 0, [0x25, 0x50, 0x44, 0x46, 0x2d]), // "%PDF-"
};

function starts(bytes: Uint8Array, at: number, prefix: number[]): boolean {
  return bytes.length >= at + prefix.length && prefix.every((v, i) => bytes[at + i] === v);
}

export function checkFile(bytes: Uint8Array, mimeType: string): void {
  const limit = ALLOWED_TYPES[mimeType];
  if (limit === undefined) throw new FileRejectedError(`File type ${mimeType} is not accepted`);
  if (bytes.length === 0) throw new FileRejectedError("The file is empty");
  if (bytes.length > limit) throw new FileRejectedError(`The file is larger than ${limit} bytes`);
  if (!SIGNATURES[mimeType]!(bytes)) {
    throw new FileRejectedError(`The file's contents are not ${mimeType}`);
  }
}

/** Content-addressed store on local disk: <root>/<ab>/<cd>/<sha256>. */
export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private pathFor(storageKey: string): string {
    if (!/^[0-9a-f]{64}$/.test(storageKey)) throw new FileRejectedError("Invalid storage key");
    return path.join(this.root, storageKey.slice(0, 2), storageKey.slice(2, 4), storageKey);
  }

  async put(bytes: Uint8Array, mimeType: string): Promise<StoredFile> {
    checkFile(bytes, mimeType);
    const sha256 = sha256Hex(bytes);
    const target = this.pathFor(sha256);
    const exists = await stat(target).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(path.dirname(target), { recursive: true });
      // "wx": never overwrite, even if two uploads of the same bytes race.
      await writeFile(target, bytes, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
    }
    return { storageKey: sha256, sha256, sizeBytes: bytes.length, mimeType };
  }

  async get(storageKey: string): Promise<Uint8Array> {
    const bytes = await readFile(this.pathFor(storageKey));
    // The hash proves the file has not changed since upload (section 8).
    if (sha256Hex(bytes) !== storageKey)
      throw new Error(`File ${storageKey} does not match its hash`);
    return bytes;
  }
}

let store: FileStore | undefined;

export function getFileStore(): FileStore {
  store ??= new LocalFileStore(process.env.FILES_DIR ?? path.join(process.cwd(), "var", "files"));
  return store;
}

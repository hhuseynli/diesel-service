const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id from a URL or form that Postgres will accept as a uuid (else: 404, not 500). */
export function isUuid(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID.test(value);
}

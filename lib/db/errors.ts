// Errors raised by the database guarantees (plan 01, "Conventions"), as typed errors.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PgErrorFields {
  code?: string;
  message?: string;
  table?: string;
  detail?: string;
  constraint?: string;
}

/** The underlying pg error; Drizzle wraps it in `cause`. */
export function pgErrorOf(e: unknown): PgErrorFields | undefined {
  let current: unknown = e;
  for (let depth = 0; current && depth < 5; depth++) {
    const fields = current as PgErrorFields & { cause?: unknown };
    if (typeof fields.code === "string") return fields;
    current = fields.cause;
  }
  return undefined;
}

export class DbGuardError extends Error {
  constructor(
    readonly sqlstate: string,
    message: string,
    readonly table: string | undefined,
    readonly recordId: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** DM001: the document is approved, posted or annulled. */
export class DocumentLockedError extends DbGuardError {}
/** DM002: rows are never deleted. */
export class DeleteForbiddenError extends DbGuardError {}
/** DM003: no acting user, or one that may not act. */
export class ActorRequiredError extends DbGuardError {}
/** DM004: an update without a reason. */
export class ReasonRequiredError extends DbGuardError {}
/** DM005: an immutable column or row. */
export class ImmutableError extends DbGuardError {}
/** DM006: a status change the lifecycle does not allow. */
export class InvalidTransitionError extends DbGuardError {}
/** 42501: the app role lacks the privilege (DELETE, TRUNCATE, writing audit_log...). */
export class PermissionDeniedError extends DbGuardError {}

const BY_SQLSTATE: Record<string, typeof DbGuardError> = {
  DM001: DocumentLockedError,
  DM002: DeleteForbiddenError,
  DM003: ActorRequiredError,
  DM004: ReasonRequiredError,
  DM005: ImmutableError,
  DM006: InvalidTransitionError,
  "42501": PermissionDeniedError,
};

/** The typed guard error for a refused write, or undefined for any other error. */
export function toGuardError(e: unknown): DbGuardError | undefined {
  if (e instanceof DbGuardError) return e;
  const pg = pgErrorOf(e);
  const ErrorClass = pg?.code ? BY_SQLSTATE[pg.code] : undefined;
  if (!pg || !ErrorClass) return undefined;
  const table =
    pg.table ?? /permission denied for (?:table|relation) "?([\w.]+)"?/.exec(pg.message ?? "")?.[1];
  const recordId = pg.detail && UUID.test(pg.detail) ? pg.detail : undefined;
  return new ErrorClass(pg.code!, pg.message ?? pg.code!, table, recordId, { cause: e });
}

-- Closes overwrite paths the app role still had (spec-checker review of plan 01):
-- 1. A numbered document keeps its vehicle, client and job order (section 3a: it keeps
--    what it was issued with).
-- 2. vehicle_plates rows are history (section 3a, rule 4: nothing is overwritten). Only
--    the lifecycle changes lib/vehicles makes are allowed: ACTIVE -> ENDED,
--    ACTIVE -> UNCONFIRMED, UNCONFIRMED -> ENDED; ENDED rows never change.
-- 3. user_roles: a role is revoked, never edited, and a revocation is never undone (F6).

CREATE OR REPLACE FUNCTION documents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.number IS NOT NULL OR NEW.doc_date IS NOT NULL
       OR NEW.vin_snapshot IS NOT NULL OR NEW.plate_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'A new document starts as DRAFT, without number, date or snapshots'
        USING ERRCODE = 'DM006', TABLE = 'documents', DETAIL = NEW.id::text;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('APPROVED', 'POSTED', 'ANNULLED') THEN
    IF OLD.status = 'APPROVED' AND NEW.status = 'POSTED'
       AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Document % (%) is % and cannot be changed; create a new version or a reversing document',
      coalesce(OLD.number, OLD.id::text), OLD.type, OLD.status
      USING ERRCODE = 'DM001', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('DRAFT', 'SUBMITTED'), ('DRAFT', 'ANNULLED'),
      ('SUBMITTED', 'APPROVED'), ('SUBMITTED', 'REJECTED'), ('SUBMITTED', 'ANNULLED'),
      ('REJECTED', 'SUBMITTED'), ('REJECTED', 'ANNULLED')) THEN
    RAISE EXCEPTION 'Document status cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'DM006', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;

  IF NEW.type IS DISTINCT FROM OLD.type
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.reverses_id IS DISTINCT FROM OLD.reverses_id THEN
    RAISE EXCEPTION 'type, version, supersedes_id and reverses_id cannot change'
      USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;

  IF (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
     OR (OLD.doc_date IS NOT NULL AND NEW.doc_date IS DISTINCT FROM OLD.doc_date)
     OR (OLD.vin_snapshot IS NOT NULL AND NEW.vin_snapshot IS DISTINCT FROM OLD.vin_snapshot)
     OR (OLD.plate_snapshot IS NOT NULL AND NEW.plate_snapshot IS DISTINCT FROM OLD.plate_snapshot) THEN
    RAISE EXCEPTION 'number, doc_date and snapshots cannot change once set'
      USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;

  -- Once numbered, the document stays about the same vehicle, client and job.
  IF OLD.number IS NOT NULL AND (
       NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
       OR NEW.contragent_id IS DISTINCT FROM OLD.contragent_id
       OR NEW.job_order_id IS DISTINCT FROM OLD.job_order_id) THEN
    RAISE EXCEPTION 'vehicle, client and job order of a numbered document cannot change'
      USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' THEN
    NEW.doc_date := baku_date();
  ELSIF (OLD.number IS NULL AND NEW.number IS NOT NULL)
     OR (OLD.vin_snapshot IS NULL AND NEW.vin_snapshot IS NOT NULL)
     OR (OLD.plate_snapshot IS NULL AND NEW.plate_snapshot IS NOT NULL)
     OR (OLD.doc_date IS NULL AND NEW.doc_date IS NOT NULL) THEN
    RAISE EXCEPTION 'number, doc_date and snapshots are set only on submission'
      USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION vehicle_plates_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'valid_to') <> (to_jsonb(OLD) - 'status' - 'valid_to')
     OR (OLD.status, NEW.status) NOT IN (
       ('ACTIVE', 'ENDED'), ('ACTIVE', 'UNCONFIRMED'), ('UNCONFIRMED', 'ENDED')) THEN
    RAISE EXCEPTION 'Plate history is never overwritten: only ACTIVE -> ENDED/UNCONFIRMED and UNCONFIRMED -> ENDED'
      USING ERRCODE = 'DM005', TABLE = 'vehicle_plates', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION user_roles_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL
     OR (to_jsonb(NEW) - 'revoked_at' - 'revoked_by' - 'revoke_reason')
        <> (to_jsonb(OLD) - 'revoked_at' - 'revoked_by' - 'revoke_reason') THEN
    RAISE EXCEPTION 'A role is only ever revoked; grant a new role instead of editing one'
      USING ERRCODE = 'DM005', TABLE = 'user_roles', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER vehicle_plates_guard BEFORE UPDATE ON vehicle_plates
  FOR EACH ROW EXECUTE FUNCTION vehicle_plates_guard();
--> statement-breakpoint
CREATE TRIGGER user_roles_guard BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_guard();

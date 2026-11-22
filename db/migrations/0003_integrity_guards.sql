-- Database guarantees that hold even for the owner role (plan 01, migration 0003;
-- spec 00 sections 5 and 7). Privileges already stop the app role; these triggers
-- stop everyone else who connects without superuser rights.

-- Nothing is deleted (spec 00, section 5.4).
CREATE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are never deleted; annul or deactivate instead', TG_TABLE_NAME
    USING ERRCODE = 'DM002';
END;
$$;
--> statement-breakpoint

-- audit_log and attachments are never changed once written (spec 00, sections 5.1 and 8).
CREATE FUNCTION forbid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are immutable', TG_TABLE_NAME USING ERRCODE = 'DM005';
END;
$$;
--> statement-breakpoint

-- Document lifecycle and locking (spec 00, sections 5.3 and 7; plan 01, F2 and F10).
CREATE FUNCTION documents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.number IS NOT NULL OR NEW.doc_date IS NOT NULL
       OR NEW.vin_snapshot IS NOT NULL OR NEW.plate_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'A new document starts as DRAFT, without number, date or snapshots'
        USING ERRCODE = 'DM006';
    END IF;
    RETURN NEW;
  END IF;

  -- Approved, posted and annulled documents are locked. The only change allowed is
  -- APPROVED -> POSTED with nothing else touched.
  IF OLD.status IN ('APPROVED', 'POSTED', 'ANNULLED') THEN
    IF OLD.status = 'APPROVED' AND NEW.status = 'POSTED'
       AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Document % (%) is % and cannot be changed; create a new version or a reversing document',
      coalesce(OLD.number, OLD.id::text), OLD.type, OLD.status
      USING ERRCODE = 'DM001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('DRAFT', 'SUBMITTED'), ('DRAFT', 'ANNULLED'),
      ('SUBMITTED', 'APPROVED'), ('SUBMITTED', 'REJECTED'), ('SUBMITTED', 'ANNULLED'),
      ('REJECTED', 'SUBMITTED'), ('REJECTED', 'ANNULLED')) THEN
    RAISE EXCEPTION 'Document status cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'DM006';
  END IF;

  -- Set at creation, never changed.
  IF NEW.type IS DISTINCT FROM OLD.type
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.reverses_id IS DISTINCT FROM OLD.reverses_id THEN
    RAISE EXCEPTION 'type, version, supersedes_id and reverses_id cannot change'
      USING ERRCODE = 'DM005';
  END IF;

  -- Set when numbered, never changed afterwards.
  IF (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
     OR (OLD.doc_date IS NOT NULL AND NEW.doc_date IS DISTINCT FROM OLD.doc_date)
     OR (OLD.vin_snapshot IS NOT NULL AND NEW.vin_snapshot IS DISTINCT FROM OLD.vin_snapshot)
     OR (OLD.plate_snapshot IS NOT NULL AND NEW.plate_snapshot IS DISTINCT FROM OLD.plate_snapshot) THEN
    RAISE EXCEPTION 'number, doc_date and snapshots cannot change once set'
      USING ERRCODE = 'DM005';
  END IF;

  -- A number, date and snapshots are given only when the document leaves draft.
  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' THEN
    NEW.doc_date := baku_date();
  ELSIF (OLD.number IS NULL AND NEW.number IS NOT NULL)
     OR (OLD.vin_snapshot IS NULL AND NEW.vin_snapshot IS NOT NULL)
     OR (OLD.plate_snapshot IS NULL AND NEW.plate_snapshot IS NOT NULL)
     OR (OLD.doc_date IS NULL AND NEW.doc_date IS NOT NULL) THEN
    RAISE EXCEPTION 'number, doc_date and snapshots are set only on submission'
      USING ERRCODE = 'DM005';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Lines of a locked document cannot be added or changed. FOR SHARE makes a concurrent
-- approval wait for this transaction, so a line cannot slip in after approval.
CREATE FUNCTION document_lines_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_status text;
  parent_number text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'A line cannot move to another document' USING ERRCODE = 'DM005';
  END IF;
  SELECT d.status, d.number INTO parent_status, parent_number
    FROM documents d WHERE d.id = NEW.document_id FOR SHARE;
  IF parent_status IN ('APPROVED', 'POSTED', 'ANNULLED') THEN
    RAISE EXCEPTION 'Document % is % and its lines cannot be changed',
      coalesce(parent_number, NEW.document_id::text), parent_status
      USING ERRCODE = 'DM001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER documents_guard BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_guard();
--> statement-breakpoint
CREATE TRIGGER document_lines_guard BEFORE INSERT OR UPDATE ON document_lines
  FOR EACH ROW EXECUTE FUNCTION document_lines_guard();
--> statement-breakpoint
CREATE TRIGGER forbid_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
--> statement-breakpoint
CREATE TRIGGER forbid_update BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
--> statement-breakpoint

-- No deletes and no truncation on any table in public.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format(
      'CREATE TRIGGER forbid_delete BEFORE DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION forbid_delete()', t);
    EXECUTE format(
      'CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete()', t);
  END LOOP;
END;
$$;

-- Refused writes carry the table (and the row id in DETAIL), so lib/audit can record
-- a DENIED audit row that says what was attempted (plan 01, F1). Same behaviour as
-- 0002 and 0003 otherwise; CREATE OR REPLACE keeps the existing triggers.

CREATE OR REPLACE FUNCTION stamp_created() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by := current_actor();
  ELSE
    PERFORM current_actor();
    IF NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION '%.created_at and created_by cannot change', TG_TABLE_NAME
        USING ERRCODE = 'DM005', TABLE = TG_TABLE_NAME, DETAIL = OLD.id::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  reason text := nullif(btrim(coalesce(current_setting('app.reason', true), '')), '');
  before_row jsonb;
  after_row jsonb := to_jsonb(NEW);
  details jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    before_row := to_jsonb(OLD);
    IF before_row = after_row THEN
      RETURN NULL;
    END IF;
    IF reason IS NULL THEN
      RAISE EXCEPTION 'Changing % requires a reason', TG_TABLE_NAME
        USING ERRCODE = 'DM004', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
    END IF;
    IF before_row -> 'pin_hash' IS DISTINCT FROM after_row -> 'pin_hash' THEN
      details := jsonb_build_object('pin_hash_changed', true);
    END IF;
    before_row := before_row - 'pin_hash';
  END IF;

  INSERT INTO audit_log (table_name, record_id, action, before, after, user_id, reason, details)
  VALUES (TG_TABLE_NAME, NEW.id, TG_OP, before_row, after_row - 'pin_hash',
          current_actor(), reason, details);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' THEN
    RAISE EXCEPTION 'Rows in % are never deleted; annul or deactivate instead', TG_TABLE_NAME
      USING ERRCODE = 'DM002', TABLE = TG_TABLE_NAME, DETAIL = OLD.id::text;
  END IF;
  RAISE EXCEPTION 'Rows in % are never deleted; annul or deactivate instead', TG_TABLE_NAME
    USING ERRCODE = 'DM002', TABLE = TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are immutable', TG_TABLE_NAME
    USING ERRCODE = 'DM005', TABLE = TG_TABLE_NAME, DETAIL = coalesce(to_jsonb(OLD) ->> 'id', '');
END;
$$;
--> statement-breakpoint

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

CREATE OR REPLACE FUNCTION document_lines_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_status text;
  parent_number text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'A line cannot move to another document'
      USING ERRCODE = 'DM005', TABLE = 'document_lines', DETAIL = OLD.id::text;
  END IF;
  SELECT d.status, d.number INTO parent_status, parent_number
    FROM documents d WHERE d.id = NEW.document_id FOR SHARE;
  IF parent_status IN ('APPROVED', 'POSTED', 'ANNULLED') THEN
    RAISE EXCEPTION 'Document % is % and its lines cannot be changed',
      coalesce(parent_number, NEW.document_id::text), parent_status
      USING ERRCODE = 'DM001', TABLE = 'document_lines', DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;

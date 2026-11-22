-- Actor stamping and the audit trail (plan 01, migration 0002; spec 00 section 5).
-- The acting user and the reason are transaction settings set by lib/audit withActor():
--   app.user_id  required for every insert and update
--   app.reason   required for every update (plan 01, F9)

-- Local date in Baku. The server runs in UTC.
CREATE FUNCTION baku_date(ts timestamptz DEFAULT now()) RETURNS date
LANGUAGE sql STABLE
AS $$ SELECT (ts AT TIME ZONE 'Asia/Baku')::date $$;
--> statement-breakpoint

-- The acting user for this transaction, or DM003.
-- The system user (fixed id) may act only in a migration-role session: seeds and
-- bootstrap scripts, never the application.
CREATE FUNCTION current_actor() RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  system_id CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  raw text := current_setting('app.user_id', true);
  actor uuid;
  active boolean;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RAISE EXCEPTION 'No acting user: writes must run inside lib/audit withActor()'
      USING ERRCODE = 'DM003';
  END IF;
  BEGIN
    actor := raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'app.user_id "%" is not a uuid', raw USING ERRCODE = 'DM003';
  END;

  IF actor = system_id THEN
    IF session_user <> 'diesel_migrator' THEN
      RAISE EXCEPTION 'The system user cannot act through the application'
        USING ERRCODE = 'DM003';
    END IF;
    RETURN actor;
  END IF;

  SELECT u.is_active INTO active FROM users u WHERE u.id = actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Acting user % does not exist', actor USING ERRCODE = 'DM003';
  END IF;
  IF NOT active THEN
    RAISE EXCEPTION 'Acting user % is deactivated', actor USING ERRCODE = 'DM003';
  END IF;
  RETURN actor;
END;
$$;
--> statement-breakpoint

-- created_at and created_by always come from the server; they never change afterwards.
-- Also requires an actor for every update, including tables without audit_row.
CREATE FUNCTION stamp_created() RETURNS trigger
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
        USING ERRCODE = 'DM005';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- One audit row per inserted or changed row, with before and after values.
-- SECURITY DEFINER: the app role cannot write audit_log itself.
-- pin_hash is never copied into the log; a change to it is noted in details.
CREATE FUNCTION audit_row() RETURNS trigger
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
      RAISE EXCEPTION 'Changing % requires a reason', TG_TABLE_NAME USING ERRCODE = 'DM004';
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

-- Records a write the database refused (spec 00, acceptance criterion 2; plan 01, F1).
-- Called by lib/audit in a new transaction, because the refused one rolled back.
CREATE FUNCTION log_denied(
  p_table text,
  p_operation text,
  p_sqlstate text,
  p_message text,
  p_record_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor uuid;
BEGIN
  BEGIN
    actor := current_actor();
  EXCEPTION WHEN SQLSTATE 'DM003' THEN
    actor := NULL;
  END;
  INSERT INTO audit_log (table_name, record_id, action, user_id, reason, details)
  VALUES (
    coalesce(nullif(p_table, ''), 'unknown'),
    p_record_id,
    'DENIED',
    actor,
    nullif(btrim(coalesce(current_setting('app.reason', true), '')), ''),
    jsonb_build_object('operation', p_operation, 'sqlstate', p_sqlstate, 'message', p_message)
  );
END;
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION baku_date(timestamptz), current_actor(),
  log_denied(text, text, text, text, uuid)
TO diesel_app;
--> statement-breakpoint

-- stamp_created on every table with created_* columns; audit_row on every business table.
-- document_counters is not audited: the number shows in the document's audit row.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings', 'users', 'user_roles', 'contragents', 'vehicles', 'vehicle_plates',
    'documents', 'document_lines', 'attachments', 'document_counters'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER stamp_created BEFORE INSERT OR UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION stamp_created()', t);
    IF t <> 'document_counters' THEN
      EXECUTE format(
        'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END;
$$;

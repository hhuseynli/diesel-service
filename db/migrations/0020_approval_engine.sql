-- The approval engine, sessions and credentials (plan 03).

GRANT SELECT, INSERT, UPDATE ON approvals, sessions, tablet_devices TO diesel_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON login_attempts TO diesel_app;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approvals', 'sessions', 'tablet_devices'] LOOP
    EXECUTE format(
      'CREATE TRIGGER stamp_created BEFORE INSERT OR UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION stamp_created()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['approvals', 'tablet_devices'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['approvals', 'sessions', 'tablet_devices', 'login_attempts'] LOOP
    EXECUTE format(
      'CREATE TRIGGER forbid_delete BEFORE DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION forbid_delete()', t);
    EXECUTE format(
      'CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete()', t);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forbid_update BEFORE UPDATE ON login_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
--> statement-breakpoint

-- Credentials never reach audit_log; a change is only noted (plan 03, A6).
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
      details := coalesce(details, '{}'::jsonb) || jsonb_build_object('pin_hash_changed', true);
    END IF;
    IF before_row -> 'password_hash' IS DISTINCT FROM after_row -> 'password_hash' THEN
      details := coalesce(details, '{}'::jsonb) || jsonb_build_object('password_hash_changed', true);
    END IF;
    IF before_row -> 'totp_secret_enc' IS DISTINCT FROM after_row -> 'totp_secret_enc' THEN
      details := coalesce(details, '{}'::jsonb) || jsonb_build_object('totp_secret_changed', true);
    END IF;
    before_row := before_row - 'pin_hash' - 'password_hash' - 'totp_secret_enc';
  END IF;

  INSERT INTO audit_log (table_name, record_id, action, before, after, user_id, reason, details)
  VALUES (TG_TABLE_NAME, NEW.id, TG_OP, before_row,
          after_row - 'pin_hash' - 'password_hash' - 'totp_secret_enc',
          current_actor(), reason, details);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- The approval rule in effect for a document type: an ordered list of roles.
CREATE FUNCTION approval_rule(doc_type text) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(s.value -> doc_type, '[]'::jsonb)
    FROM settings s
   WHERE s.key = 'approval_rules' AND s.effective_from <= now()
   ORDER BY s.effective_from DESC LIMIT 1
$$;
--> statement-breakpoint

-- Approved when every step of the latest round is approved, or the type has no steps.
CREATE FUNCTION document_round_approved(doc_id uuid, doc_type text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM approvals a WHERE a.document_id = doc_id)
      THEN jsonb_array_length(coalesce(approval_rule(doc_type), '[]'::jsonb)) = 0
    ELSE NOT EXISTS (
      SELECT 1 FROM approvals a
       WHERE a.document_id = doc_id AND a.status <> 'APPROVED'
         AND a.round = (SELECT max(b.round) FROM approvals b WHERE b.document_id = doc_id))
  END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION approval_rule(text), document_round_approved(uuid, text) TO diesel_app;
--> statement-breakpoint

-- Who may decide a step, and when (spec 00, section 6; AC3; plan 03, A3).
CREATE FUNCTION approvals_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  doc record;
  actor uuid;
BEGIN
  SELECT d.status, d.created_by INTO doc FROM documents d WHERE d.id = NEW.document_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.method <> 'MANUAL' THEN
      RAISE EXCEPTION 'A new approval step is PENDING and MANUAL'
        USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = NEW.id::text;
    END IF;
    IF doc.status IS DISTINCT FROM 'SUBMITTED' THEN
      RAISE EXCEPTION 'Approval steps belong to a submitted document'
        USING ERRCODE = 'DM006', TABLE = 'approvals', DETAIL = NEW.id::text;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'A decided approval step cannot change'
      USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'comment')
     <> (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'comment') THEN
    RAISE EXCEPTION 'Only the decision of an approval step can change'
      USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  IF NEW.status IN ('PENDING', 'CANCELLED') THEN
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    RETURN NEW;
  END IF;

  -- APPROVED or REJECTED: a person decides, now, in order.
  IF doc.status IS DISTINCT FROM 'SUBMITTED'
     OR NEW.round <> (SELECT max(a.round) FROM approvals a WHERE a.document_id = NEW.document_id)
     OR EXISTS (SELECT 1 FROM approvals a
                 WHERE a.document_id = NEW.document_id AND a.round = NEW.round
                   AND a.step_no < NEW.step_no AND a.status <> 'APPROVED') THEN
    RAISE EXCEPTION 'Steps are decided in order, in the current round of a submitted document'
      USING ERRCODE = 'DM006', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  actor := current_actor();
  IF actor = doc.created_by THEN
    RAISE EXCEPTION 'A document cannot be approved or rejected by the user who created it'
      USING ERRCODE = 'DM007', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  IF NEW.required_role = 'CLIENT' OR NOT EXISTS (
       SELECT 1 FROM user_roles r
        WHERE r.user_id = actor AND r.revoked_at IS NULL
          AND r.role IN (NEW.required_role, 'OWNER')) THEN
    RAISE EXCEPTION 'This step needs the % role', NEW.required_role
      USING ERRCODE = 'DM007', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  NEW.decided_by := actor;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_guard BEFORE INSERT OR UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION documents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  predecessor_number text;
  predecessor record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.number IS NOT NULL OR NEW.doc_date IS NOT NULL
       OR NEW.vin_snapshot IS NOT NULL OR NEW.plate_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'A new document starts as DRAFT, without number, date or snapshots'
        USING ERRCODE = 'DM006', TABLE = 'documents', DETAIL = NEW.id::text;
    END IF;
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT d.type, d.version, d.status INTO predecessor FROM documents d WHERE d.id = NEW.supersedes_id;
      IF predecessor.type IS DISTINCT FROM NEW.type
         OR NEW.version IS DISTINCT FROM predecessor.version + 1
         OR predecessor.status NOT IN ('APPROVED', 'POSTED') THEN
        RAISE EXCEPTION 'A corrected version follows an approved or posted document of the same type, with the next version'
          USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = NEW.id::text;
      END IF;
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

  -- Only the approval engine approves or rejects (plan 03, A3).
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED' AND NOT document_round_approved(OLD.id, OLD.type) THEN
    RAISE EXCEPTION 'Document % is approved only when every step of its current approval round is approved',
      coalesce(OLD.number, OLD.id::text)
      USING ERRCODE = 'DM006', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'REJECTED' AND NOT EXISTS (
       SELECT 1 FROM approvals a
        WHERE a.document_id = OLD.id AND a.status = 'REJECTED'
          AND a.round = (SELECT max(b.round) FROM approvals b WHERE b.document_id = OLD.id)) THEN
    RAISE EXCEPTION 'Document % is rejected only through a rejected approval step', coalesce(OLD.number, OLD.id::text)
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

  IF OLD.number IS NOT NULL AND (
       NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
       OR NEW.contragent_id IS DISTINCT FROM OLD.contragent_id
       OR NEW.job_order_id IS DISTINCT FROM OLD.job_order_id) THEN
    RAISE EXCEPTION 'vehicle, client and job order of a numbered document cannot change'
      USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' THEN
    -- The number comes from the counter, or for a corrected version from its predecessor.
    IF NEW.supersedes_id IS NULL THEN
      IF NOT number_from_counter(NEW.type, NEW.number) THEN
        RAISE EXCEPTION 'Document number % was not assigned by the counter (lib/numbering)', NEW.number
          USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = OLD.id::text;
      END IF;
    ELSE
      SELECT d.number INTO predecessor_number FROM documents d WHERE d.id = NEW.supersedes_id;
      IF NEW.number IS DISTINCT FROM predecessor_number THEN
        RAISE EXCEPTION 'A corrected version keeps its predecessor''s number %', predecessor_number
          USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = OLD.id::text;
      END IF;
    END IF;
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

-- Sessions: only last seen and the end change, with server time (plan 03, A8).
CREATE FUNCTION sessions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.last_seen_at := now();
    NEW.ended_at := NULL;
    NEW.end_reason := NULL;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL
     OR (to_jsonb(NEW) - 'last_seen_at' - 'ended_at' - 'end_reason')
        <> (to_jsonb(OLD) - 'last_seen_at' - 'ended_at' - 'end_reason') THEN
    RAISE EXCEPTION 'An ended session cannot change; only last_seen_at and the end can'
      USING ERRCODE = 'DM005', TABLE = 'sessions', DETAIL = OLD.id::text;
  END IF;
  IF NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at THEN
    NEW.last_seen_at := now();
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sessions_guard BEFORE INSERT OR UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_guard();
--> statement-breakpoint

-- A registered tablet is only ever revoked, at server time.
CREATE FUNCTION tablet_devices_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (to_jsonb(NEW) - 'revoked_at') <> (to_jsonb(OLD) - 'revoked_at') THEN
    RAISE EXCEPTION 'A tablet is only revoked, once'
      USING ERRCODE = 'DM005', TABLE = 'tablet_devices', DETAIL = OLD.id::text;
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tablet_devices_guard BEFORE UPDATE ON tablet_devices
  FOR EACH ROW EXECUTE FUNCTION tablet_devices_guard();
--> statement-breakpoint

-- Approval steps per document type (spec 00, section 6; plan 03, A2). PAYMENT_CONFIRMER
-- is resolved at submission: CASHIER for cash, BOOKKEEPER for transfer. CLIENT steps are
-- decided by the client from milestone 6 (A1). TEHVIL_TESLIM is signed on screen and has
-- no approval steps (F28).
SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000001', true);
--> statement-breakpoint
SELECT set_config('app.reason', 'seed', true);
--> statement-breakpoint
INSERT INTO settings (key, value, effective_from) VALUES ('approval_rules', '{
  "QUSUR_AKTI": ["CLIENT"],
  "ELAVE_AKT": ["CLIENT"],
  "QIYMET_PROTOKOLU": ["MANAGEMENT"],
  "TEHVIL_TESLIM": [],
  "SATIS": ["MANAGEMENT", "PAYMENT_CONFIRMER"],
  "ALIS": ["MANAGEMENT"],
  "MEDAXIL": ["MANAGEMENT"],
  "MEXARIC": ["MANAGEMENT"],
  "SILINME": ["MANAGEMENT"],
  "INVENTAR": ["MANAGEMENT"]
}', '2026-01-01 00:00:00+04');
--> statement-breakpoint
SELECT set_config('app.user_id', '', true);
--> statement-breakpoint
SELECT set_config('app.reason', '', true);

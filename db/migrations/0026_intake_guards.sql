-- Intake, inspection and workshop records (plan 04). Grants, standard triggers, and the
-- preconditions of each status the formen moves a job into (spec 01, AC3 and AC6).

GRANT SELECT, INSERT ON intake_photos, odometer_readings, intake_confirmations,
  inspection_finding_attachments, removed_parts, quality_checks, vin_decodes, document_signatures
TO diesel_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON inspection_findings, planned_services, parts_requests, qr_stickers
TO diesel_app;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'intake_photos', 'odometer_readings', 'intake_confirmations', 'inspection_findings',
    'inspection_finding_attachments', 'planned_services', 'parts_requests', 'qr_stickers',
    'vin_decodes', 'quality_checks', 'removed_parts', 'document_signatures'
  ] LOOP
    EXECUTE format('CREATE TRIGGER stamp_created BEFORE INSERT OR UPDATE ON %I
                      FOR EACH ROW EXECUTE FUNCTION stamp_created()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON %I
                      FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    EXECUTE format('CREATE TRIGGER forbid_delete BEFORE DELETE ON %I
                      FOR EACH ROW EXECUTE FUNCTION forbid_delete()', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete()', t);
  END LOOP;
  -- Evidence is written once: photos, readings, confirmations, checks, signatures.
  FOREACH t IN ARRAY ARRAY[
    'intake_photos', 'odometer_readings', 'intake_confirmations', 'inspection_finding_attachments',
    'vin_decodes', 'quality_checks', 'removed_parts', 'document_signatures'
  ] LOOP
    EXECUTE format('CREATE TRIGGER forbid_update BEFORE UPDATE ON %I
                      FOR EACH ROW EXECUTE FUNCTION forbid_update()', t);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- The odometer against the vehicle's previous reading (spec 01, 3.4; R9; plan 04, B6).
CREATE FUNCTION odometer_readings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous record;
  max_per_day int;
BEGIN
  IF NEW.vehicle_id IS DISTINCT FROM (SELECT j.vehicle_id FROM job_orders j WHERE j.id = NEW.job_order_id) THEN
    RAISE EXCEPTION 'An odometer reading belongs to its job''s vehicle'
      USING ERRCODE = 'DM005', TABLE = 'odometer_readings', DETAIL = NEW.id::text;
  END IF;
  SELECT r.value_km, r.created_at INTO previous FROM odometer_readings r
   WHERE r.vehicle_id = NEW.vehicle_id ORDER BY r.created_at DESC LIMIT 1;
  max_per_day := coalesce((SELECT (s.value #>> '{}')::int FROM settings s
                            WHERE s.key = 'odometer_max_km_per_day' AND s.effective_from <= now()
                            ORDER BY s.effective_from DESC LIMIT 1), 1000);
  NEW.below_previous := previous.value_km IS NOT NULL AND NEW.value_km < previous.value_km;
  NEW.above_daily_limit := previous.value_km IS NOT NULL
    AND NEW.value_km - previous.value_km >
        max_per_day * greatest(1, ceil(extract(epoch FROM now() - previous.created_at) / 86400));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER odometer_readings_guard BEFORE INSERT ON odometer_readings
  FOR EACH ROW EXECUTE FUNCTION odometer_readings_guard();
--> statement-breakpoint

-- Findings: a mechanic each; edited only while the job is still in QEBUL ("Anbara
-- göndər" ends that, spec 01 3.6); at least one attachment by commit (AC6).
CREATE FUNCTION inspection_findings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_status text;
BEGIN
  SELECT j.status INTO job_status FROM job_orders j WHERE j.id = NEW.job_order_id;
  IF job_status IN ('BAGLANDI', 'LEGV', 'TEHVIL_VERILDI', 'ODENILDI') THEN
    RAISE EXCEPTION 'Findings cannot be recorded on a job that is %', job_status
      USING ERRCODE = 'DM001', TABLE = 'inspection_findings', DETAIL = NEW.id::text;
  END IF;
  IF TG_OP = 'UPDATE' AND (job_status <> 'QEBUL' OR NEW.job_order_id <> OLD.job_order_id) THEN
    RAISE EXCEPTION 'After "Anbara göndər" findings are only added; record a correction instead'
      USING ERRCODE = 'DM005', TABLE = 'inspection_findings', DETAIL = OLD.id::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = NEW.mechanic_id
                   AND r.role = 'MECHANIC' AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'A finding''s mechanic must hold the MECHANIC role'
      USING ERRCODE = 'DM005', TABLE = 'inspection_findings', DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_findings_guard BEFORE INSERT OR UPDATE ON inspection_findings
  FOR EACH ROW EXECUTE FUNCTION inspection_findings_guard();
--> statement-breakpoint

CREATE FUNCTION inspection_finding_has_evidence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inspection_finding_attachments a WHERE a.finding_id = NEW.id) THEN
    RAISE EXCEPTION 'Every finding has at least one photo or video (R2)'
      USING ERRCODE = 'DM005', TABLE = 'inspection_findings', DETAIL = NEW.id::text;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER inspection_finding_has_evidence
  AFTER INSERT ON inspection_findings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inspection_finding_has_evidence();
--> statement-breakpoint

-- Parts requests: the warehouse matches or cancels them; the request itself is fixed.
CREATE FUNCTION parts_requests_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'matched_item_id') <> (to_jsonb(OLD) - 'status' - 'matched_item_id')
     OR OLD.status = 'CANCELLED'
     OR (OLD.status, NEW.status) NOT IN (('NEW', 'NEW'), ('NEW', 'MATCHED'), ('NEW', 'CANCELLED'),
                                         ('MATCHED', 'MATCHED'), ('MATCHED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'A parts request is only matched or cancelled'
      USING ERRCODE = 'DM005', TABLE = 'parts_requests', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER parts_requests_guard BEFORE UPDATE ON parts_requests
  FOR EACH ROW EXECUTE FUNCTION parts_requests_guard();
--> statement-breakpoint

-- A sticker is only ever replaced, with a reason (spec 01, section 4).
CREATE FUNCTION qr_stickers_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REPLACED'
     OR (to_jsonb(NEW) - 'status' - 'replace_reason') <> (to_jsonb(OLD) - 'status' - 'replace_reason') THEN
    RAISE EXCEPTION 'A QR sticker is only replaced, once'
      USING ERRCODE = 'DM005', TABLE = 'qr_stickers', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER qr_stickers_guard BEFORE UPDATE ON qr_stickers
  FOR EACH ROW EXECUTE FUNCTION qr_stickers_guard();
--> statement-breakpoint

-- What each status needs (spec 01, AC3; plan 04, B8, B10, B11).
CREATE FUNCTION job_orders_intake_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  entered_work timestamptz;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'QEBUL' AND NEW.status = 'BAXIS' AND (
       (SELECT count(DISTINCT p.slot) FROM intake_photos p WHERE p.job_order_id = OLD.id) < 6
       OR NOT EXISTS (SELECT 1 FROM odometer_readings r WHERE r.job_order_id = OLD.id)
       OR NOT EXISTS (SELECT 1 FROM intake_confirmations c WHERE c.job_order_id = OLD.id)) THEN
    RAISE EXCEPTION 'Job % needs six intake photos, an odometer reading and a confirmation', OLD.number
      USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;

  -- Temporary until stock issues (milestone 5): every parts request settled (B8).
  IF NEW.status = 'TEMIRDE' AND OLD.status IN ('TESDIQLENDI', 'HISSE_GOZLEYIR') AND EXISTS (
       SELECT 1 FROM parts_requests p WHERE p.job_order_id = OLD.id AND p.status = 'NEW') THEN
    RAISE EXCEPTION 'Job % has parts requests the warehouse has not matched yet', OLD.number
      USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;

  IF NEW.status = 'HAZIR' THEN
    SELECT max(e.at) INTO entered_work FROM job_status_events e
     WHERE e.job_order_id = OLD.id AND e.to_status = 'TEMIRDE';
    IF NOT EXISTS (
         SELECT 1 FROM quality_checks q
          WHERE q.job_order_id = OLD.id AND q.passed AND q.created_at >= coalesce(entered_work, '-infinity')) THEN
      RAISE EXCEPTION 'Job % needs a passed quality check before HAZIR', OLD.number
        USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = OLD.id::text;
    END IF;
  END IF;

  IF NEW.status = 'TEHVIL_VERILDI' AND NOT EXISTS (
       SELECT 1 FROM documents d JOIN document_signatures s ON s.document_id = d.id
        WHERE d.job_order_id = OLD.id AND d.type = 'TEHVIL_TESLIM' AND d.status IN ('APPROVED', 'POSTED')) THEN
    RAISE EXCEPTION 'Job % needs a signed Təhvil-Təslim aktı before handover', OLD.number
      USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_orders_intake_guard BEFORE UPDATE ON job_orders
  FOR EACH ROW EXECUTE FUNCTION job_orders_intake_guard();
--> statement-breakpoint

SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000001', true);
--> statement-breakpoint
SELECT set_config('app.reason', 'seed', true);
--> statement-breakpoint
INSERT INTO settings (key, value, effective_from) VALUES
  ('quality_checklist', '["TEST_DRIVE", "NO_WARNING_LIGHTS", "FLUIDS_CHECKED", "CAR_CLEAN"]', '2026-01-01 00:00:00+04'),
  ('odometer_max_km_per_day', '1000', '2026-01-01 00:00:00+04'),
  ('job_board_amber_hours', '24', '2026-01-01 00:00:00+04');
--> statement-breakpoint
SELECT set_config('app.user_id', '', true);
--> statement-breakpoint
SELECT set_config('app.reason', '', true);

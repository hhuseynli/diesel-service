-- Milestone 4, second review: gaps left by 0028/0030.

-- The guards lock the job row, so an insert cannot slip in while the job moves on.
CREATE OR REPLACE FUNCTION job_additions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_status text;
  corrects uuid;
BEGIN
  SELECT j.status INTO job_status FROM job_orders j WHERE j.id = NEW.job_order_id FOR SHARE;
  IF job_status IS NULL OR job_status NOT IN ('QEBUL', 'BAXIS', 'QIYMETLENDIRME',
       'TESDIQ_GOZLEYIR', 'TESDIQLENDI', 'HISSE_GOZLEYIR', 'TEMIRDE') THEN
    RAISE EXCEPTION 'Nothing is added to a job in status %', job_status
      USING ERRCODE = 'DM001', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
  END IF;
  NEW.additional := job_status IN ('TESDIQ_GOZLEYIR', 'TESDIQLENDI', 'HISSE_GOZLEYIR', 'TEMIRDE');

  -- A correction points at a finding of the same job (its reason is a CHECK).
  IF TG_TABLE_NAME = 'inspection_findings' THEN
    corrects := (to_jsonb(NEW) ->> 'corrects_id')::uuid;
    IF corrects IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM inspection_findings f
          WHERE f.id = corrects AND f.job_order_id = NEW.job_order_id) THEN
      RAISE EXCEPTION 'A correction belongs to a finding of the same job'
        USING ERRCODE = 'DM005', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION job_in_work_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_status text;
BEGIN
  SELECT j.status INTO job_status FROM job_orders j WHERE j.id = NEW.job_order_id FOR SHARE;
  IF job_status IS DISTINCT FROM 'TEMIRDE' THEN
    RAISE EXCEPTION '% is recorded while the job is in work, not in %', TG_TABLE_NAME, job_status
      USING ERRCODE = 'DM001', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A finding edited in QEBUL keeps what the database decided: whether it is additional,
-- and what it corrects. Corrections are new rows (spec 01, 3.6).
CREATE FUNCTION inspection_findings_fixed_fields() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.additional IS DISTINCT FROM OLD.additional
     OR NEW.corrects_id IS DISTINCT FROM OLD.corrects_id
     OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason THEN
    RAISE EXCEPTION 'A finding''s correction and additional flag are set when it is recorded'
      USING ERRCODE = 'DM005', TABLE = 'inspection_findings', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_findings_fixed_fields BEFORE UPDATE ON inspection_findings
  FOR EACH ROW EXECUTE FUNCTION inspection_findings_fixed_fields();
--> statement-breakpoint

-- Who did the work is not rewritten once the work is done (R3): a planned service's and the
-- job's mechanic change only until HAZIR.
CREATE OR REPLACE FUNCTION planned_services_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_status text;
BEGIN
  IF (to_jsonb(NEW) - 'item_id' - 'mechanic_id') <> (to_jsonb(OLD) - 'item_id' - 'mechanic_id') THEN
    RAISE EXCEPTION 'A planned service changes only its catalog item and mechanic'
      USING ERRCODE = 'DM005', TABLE = 'planned_services', DETAIL = OLD.id::text;
  END IF;
  IF NEW.mechanic_id IS DISTINCT FROM OLD.mechanic_id THEN
    SELECT j.status INTO job_status FROM job_orders j WHERE j.id = OLD.job_order_id FOR SHARE;
    IF job_status NOT IN ('QEBUL', 'BAXIS', 'QIYMETLENDIRME', 'TESDIQ_GOZLEYIR', 'TESDIQLENDI',
                          'HISSE_GOZLEYIR', 'TEMIRDE') THEN
      RAISE EXCEPTION 'The mechanic is not changed on a job in status %', job_status
        USING ERRCODE = 'DM001', TABLE = 'planned_services', DETAIL = OLD.id::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION job_mechanic_until_ready() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.mechanic_id IS DISTINCT FROM OLD.mechanic_id AND OLD.status NOT IN ('QEBUL', 'BAXIS',
       'QIYMETLENDIRME', 'TESDIQ_GOZLEYIR', 'TESDIQLENDI', 'HISSE_GOZLEYIR', 'TEMIRDE') THEN
    RAISE EXCEPTION 'The mechanic is not changed on a job in status %', OLD.status
      USING ERRCODE = 'DM001', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_mechanic_until_ready BEFORE UPDATE OF mechanic_id ON job_orders
  FOR EACH ROW EXECUTE FUNCTION job_mechanic_until_ready();
--> statement-breakpoint
-- job_staff_roles_ok (0018) already checks the job's mechanic, and only when it changes.
DROP TRIGGER mechanic_is_mechanic ON job_orders;
--> statement-breakpoint

-- Photos on work rows are photos: the dashboard photo (B10) and the old part's (B9).
CREATE FUNCTION photo_column_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mime text;
BEGIN
  SELECT a.mime_type INTO mime FROM attachments a
   WHERE a.id = (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF mime IS NULL OR mime NOT IN ('image/jpeg', 'image/png') THEN
    RAISE EXCEPTION '%.% is a photo, not %', TG_TABLE_NAME, TG_ARGV[0], mime
      USING ERRCODE = 'DM005', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER photo_column_guard BEFORE INSERT ON removed_parts
  FOR EACH ROW EXECUTE FUNCTION photo_column_guard('photo_id');
--> statement-breakpoint
CREATE TRIGGER photo_column_guard BEFORE INSERT ON quality_checks
  FOR EACH ROW EXECUTE FUNCTION photo_column_guard('dashboard_photo_id');
--> statement-breakpoint

-- HAZIR waits for every parts request too, including those added during work (B8 is
-- temporary until stock issues; an additional request waits for the client's approval).
CREATE FUNCTION job_ready_parts_settled() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'HAZIR' AND OLD.status IS DISTINCT FROM 'HAZIR' AND EXISTS (
       SELECT 1 FROM parts_requests p WHERE p.job_order_id = OLD.id AND p.status = 'NEW') THEN
    RAISE EXCEPTION 'Job % has parts requests the warehouse has not settled', OLD.number
      USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_ready_parts_settled BEFORE UPDATE OF status ON job_orders
  FOR EACH ROW EXECUTE FUNCTION job_ready_parts_settled();

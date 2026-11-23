-- Milestone 4 review: rules that lived only in lib move into the database.

-- Findings, planned services and parts requests are added from intake until the work is
-- done. Whether a row is additional (an ELAVE_AKT request, spec 01 3.7) is decided here
-- from the job's status, never by the client: once the estimate is with the client.
CREATE FUNCTION job_additions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_status text;
BEGIN
  SELECT j.status INTO job_status FROM job_orders j WHERE j.id = NEW.job_order_id;
  IF job_status IS NULL OR job_status NOT IN ('QEBUL', 'BAXIS', 'QIYMETLENDIRME',
       'TESDIQ_GOZLEYIR', 'TESDIQLENDI', 'HISSE_GOZLEYIR', 'TEMIRDE') THEN
    RAISE EXCEPTION 'Nothing is added to a job in status %', job_status
      USING ERRCODE = 'DM001', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
  END IF;
  NEW.additional := job_status IN ('TESDIQ_GOZLEYIR', 'TESDIQLENDI', 'HISSE_GOZLEYIR', 'TEMIRDE');

  -- A correction points at a finding of the same job (its reason is a CHECK).
  IF TG_TABLE_NAME = 'inspection_findings' AND NEW.corrects_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM inspection_findings f
        WHERE f.id = NEW.corrects_id AND f.job_order_id = NEW.job_order_id) THEN
    RAISE EXCEPTION 'A correction belongs to a finding of the same job'
      USING ERRCODE = 'DM005', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_additions_guard BEFORE INSERT ON inspection_findings
  FOR EACH ROW EXECUTE FUNCTION job_additions_guard();
--> statement-breakpoint
CREATE TRIGGER job_additions_guard BEFORE INSERT ON planned_services
  FOR EACH ROW EXECUTE FUNCTION job_additions_guard();
--> statement-breakpoint
CREATE TRIGGER job_additions_guard BEFORE INSERT ON parts_requests
  FOR EACH ROW EXECUTE FUNCTION job_additions_guard();
--> statement-breakpoint

-- Removed parts and quality checks are recorded while the job is in work (3.7).
CREATE FUNCTION job_in_work_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_status text;
BEGIN
  SELECT j.status INTO job_status FROM job_orders j WHERE j.id = NEW.job_order_id;
  IF job_status IS DISTINCT FROM 'TEMIRDE' THEN
    RAISE EXCEPTION '% is recorded while the job is in work, not in %', TG_TABLE_NAME, job_status
      USING ERRCODE = 'DM001', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_in_work_guard BEFORE INSERT ON removed_parts
  FOR EACH ROW EXECUTE FUNCTION job_in_work_guard();
--> statement-breakpoint
CREATE TRIGGER job_in_work_guard BEFORE INSERT ON quality_checks
  FOR EACH ROW EXECUTE FUNCTION job_in_work_guard();
--> statement-breakpoint

-- The mechanic named on any work row holds the MECHANIC role (R3), as findings already do.
CREATE FUNCTION mechanic_is_mechanic() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.mechanic_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM user_roles r
        WHERE r.user_id = NEW.mechanic_id AND r.role = 'MECHANIC' AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'The mechanic on % must hold the MECHANIC role', TG_TABLE_NAME
      USING ERRCODE = 'DM005', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mechanic_is_mechanic BEFORE INSERT OR UPDATE OF mechanic_id ON planned_services
  FOR EACH ROW EXECUTE FUNCTION mechanic_is_mechanic();
--> statement-breakpoint
CREATE TRIGGER mechanic_is_mechanic BEFORE INSERT OR UPDATE OF mechanic_id ON quality_checks
  FOR EACH ROW EXECUTE FUNCTION mechanic_is_mechanic();
--> statement-breakpoint
CREATE TRIGGER mechanic_is_mechanic BEFORE INSERT OR UPDATE OF mechanic_id ON removed_parts
  FOR EACH ROW EXECUTE FUNCTION mechanic_is_mechanic();
--> statement-breakpoint
CREATE TRIGGER mechanic_is_mechanic BEFORE INSERT OR UPDATE OF mechanic_id ON job_orders
  FOR EACH ROW EXECUTE FUNCTION mechanic_is_mechanic();
--> statement-breakpoint

-- A planned service keeps its text and job; only the catalog match (milestone 5) and the
-- mechanic change. What the client approved stays as approved.
CREATE FUNCTION planned_services_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'item_id' - 'mechanic_id') <> (to_jsonb(OLD) - 'item_id' - 'mechanic_id') THEN
    RAISE EXCEPTION 'A planned service changes only its catalog item and mechanic'
      USING ERRCODE = 'DM005', TABLE = 'planned_services', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER planned_services_guard BEFORE UPDATE ON planned_services
  FOR EACH ROW EXECUTE FUNCTION planned_services_guard();
--> statement-breakpoint

-- Evidence types (spec 00 section 8; spec 01 3.4, 3.6): intake photos are photos; a
-- finding's evidence is a photo or a short video, never a document.
CREATE FUNCTION evidence_type_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mime text;
  allowed text[] := CASE TG_TABLE_NAME
    WHEN 'intake_photos' THEN ARRAY['image/jpeg', 'image/png']
    ELSE ARRAY['image/jpeg', 'image/png', 'video/mp4'] END;
BEGIN
  SELECT a.mime_type INTO mime FROM attachments a WHERE a.id = NEW.attachment_id;
  IF mime IS NULL OR NOT mime = ANY (allowed) THEN
    RAISE EXCEPTION '% does not accept files of type %', TG_TABLE_NAME, mime
      USING ERRCODE = 'DM005', TABLE = TG_TABLE_NAME, DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_type_guard BEFORE INSERT ON intake_photos
  FOR EACH ROW EXECUTE FUNCTION evidence_type_guard();
--> statement-breakpoint
CREATE TRIGGER evidence_type_guard BEFORE INSERT ON inspection_finding_attachments
  FOR EACH ROW EXECUTE FUNCTION evidence_type_guard();

-- 0028's job_additions_guard read NEW.corrects_id in one condition with the table check;
-- PL/pgSQL resolves the field on every table, so planned_services and parts_requests
-- inserts failed (42703). The correction check now sits in its own branch.
CREATE OR REPLACE FUNCTION job_additions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_status text;
  corrects uuid;
BEGIN
  SELECT j.status INTO job_status FROM job_orders j WHERE j.id = NEW.job_order_id;
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

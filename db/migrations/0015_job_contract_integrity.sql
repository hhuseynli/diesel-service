-- Closes gaps found by the spec-checker review of plan 02:
-- * job_orders: client, contract link and contract check are fixed at opening; the
--   contract link must match the client and the car; a job held for management cannot
--   leave QEBUL until the hold is resolved (HOLD_FOR_MANAGEMENT -> SEPARATE_PAID); job
--   numbers must come from the counter.
-- * documents: a first submission's number must come from the counter (plan 01 review);
--   a document on a job takes the job's client as well as its vehicle.
-- * contract_vehicles: only ACTIVE contracts take cars; added_on, removed_on and
--   removed_by are set by the database.

-- True when `number` (<PREFIX>-<YEAR>-<SEQ>) was handed out by document_counters for
-- this series in the current Baku year. With gapless counters and unique numbers, the
-- only such number not yet used is the one just assigned.
CREATE FUNCTION number_from_counter(series text, number text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT substr(number, 4, 4)::int = extract(year FROM baku_date())::int
     AND EXISTS (
       SELECT 1 FROM document_counters c
        WHERE c.doc_type = series
          AND c.year = substr(number, 4, 4)::int
          AND c.last_number >= right(number, 6)::int)
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION number_from_counter(text, text) TO diesel_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION job_orders_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed text[];
  paid boolean;
  handed_over boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QEBUL' OR NEW.cancel_reason IS NOT NULL THEN
      RAISE EXCEPTION 'A new job order starts in QEBUL'
        USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = NEW.id::text;
    END IF;
    IF NOT number_from_counter('JOB_ORDER', NEW.number) THEN
      RAISE EXCEPTION 'Job number % was not assigned by the counter (lib/numbering)', NEW.number
        USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = NEW.id::text;
    END IF;
    -- Only a car on a valid contract of this client is linked to the contract.
    IF (NEW.contract_check = 'ON_CONTRACT') <> (NEW.contract_id IS NOT NULL)
       OR (NEW.contract_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM contracts c
           JOIN contract_vehicles cv ON cv.contract_id = c.id AND cv.removed_on IS NULL
          WHERE c.id = NEW.contract_id AND c.contragent_id = NEW.contragent_id
            AND cv.vehicle_id = NEW.vehicle_id)) THEN
      RAISE EXCEPTION 'The job''s contract must be a contract of its client that covers its car'
        USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = NEW.id::text;
    END IF;
    SELECT v.vin, vp.plate_display INTO NEW.vin_snapshot, NEW.plate_snapshot
      FROM vehicles v
      LEFT JOIN vehicle_plates vp ON vp.vehicle_id = v.id AND vp.status = 'ACTIVE'
     WHERE v.id = NEW.vehicle_id;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('BAGLANDI', 'LEGV') THEN
    RAISE EXCEPTION 'Job % is % and cannot be changed', OLD.number, OLD.status
      USING ERRCODE = 'DM001', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;

  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
     OR NEW.vin_snapshot IS DISTINCT FROM OLD.vin_snapshot
     OR NEW.plate_snapshot IS DISTINCT FROM OLD.plate_snapshot
     OR NEW.contragent_id IS DISTINCT FROM OLD.contragent_id
     OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.contract_check IS DISTINCT FROM OLD.contract_check THEN
    RAISE EXCEPTION 'number, vehicle, client, contract and snapshots of a job cannot change'
      USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;

  -- The recorded contract decision only changes when management resolves a hold.
  IF NEW.contract_decision IS DISTINCT FROM OLD.contract_decision
     AND NOT (OLD.contract_decision = 'HOLD_FOR_MANAGEMENT'
              AND NEW.contract_decision = 'SEPARATE_PAID') THEN
    RAISE EXCEPTION 'The contract decision can only change from HOLD_FOR_MANAGEMENT to SEPARATE_PAID'
      USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.contract_decision = 'HOLD_FOR_MANAGEMENT' AND NEW.status <> 'LEGV' THEN
      RAISE EXCEPTION 'Job % is held for management (contract check %)', OLD.number, OLD.contract_check
        USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = OLD.id::text;
    END IF;

    allowed := CASE OLD.status
      WHEN 'QEBUL' THEN ARRAY['BAXIS', 'LEGV']
      WHEN 'BAXIS' THEN ARRAY['QIYMETLENDIRME', 'LEGV']
      WHEN 'QIYMETLENDIRME' THEN ARRAY['TESDIQ_GOZLEYIR', 'LEGV']
      WHEN 'TESDIQ_GOZLEYIR' THEN ARRAY['TESDIQLENDI', 'QIYMETLENDIRME', 'LEGV']
      WHEN 'TESDIQLENDI' THEN ARRAY['HISSE_GOZLEYIR', 'TEMIRDE', 'LEGV']
      WHEN 'HISSE_GOZLEYIR' THEN ARRAY['TEMIRDE', 'LEGV']
      WHEN 'TEMIRDE' THEN ARRAY['HAZIR', 'HISSE_GOZLEYIR', 'LEGV']
      WHEN 'HAZIR' THEN ARRAY['TEMIRDE', 'ODENILDI', 'TEHVIL_VERILDI', 'LEGV']
      WHEN 'ODENILDI' THEN ARRAY['TEHVIL_VERILDI', 'BAGLANDI']
      WHEN 'TEHVIL_VERILDI' THEN ARRAY['ODENILDI', 'BAGLANDI']
      ELSE ARRAY[]::text[]
    END;
    IF NOT NEW.status = ANY (allowed) THEN
      RAISE EXCEPTION 'Job status cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = OLD.id::text;
    END IF;

    SELECT coalesce(bool_or(e.to_status = 'ODENILDI'), false),
           coalesce(bool_or(e.to_status = 'TEHVIL_VERILDI'), false)
      INTO paid, handed_over
      FROM job_status_events e WHERE e.job_order_id = OLD.id;
    IF (NEW.status = 'BAGLANDI' AND NOT (paid AND handed_over))
       OR (NEW.status = 'ODENILDI' AND paid)
       OR (NEW.status = 'TEHVIL_VERILDI' AND handed_over) THEN
      RAISE EXCEPTION 'Job % cannot go to % (paid: %, handed over: %)',
        OLD.number, NEW.status, paid, handed_over
        USING ERRCODE = 'DM006', TABLE = 'job_orders', DETAIL = OLD.id::text;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION documents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  predecessor_number text;
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

-- A document on a job is about the job's vehicle and client.
CREATE OR REPLACE FUNCTION documents_job_vehicle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_vehicle uuid;
  job_client uuid;
BEGIN
  IF NEW.job_order_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT j.vehicle_id, j.contragent_id INTO job_vehicle, job_client
    FROM job_orders j WHERE j.id = NEW.job_order_id;
  NEW.vehicle_id := coalesce(NEW.vehicle_id, job_vehicle);
  NEW.contragent_id := coalesce(NEW.contragent_id, job_client);
  IF NEW.vehicle_id <> job_vehicle OR NEW.contragent_id <> job_client THEN
    RAISE EXCEPTION 'A document on a job must be about the job''s vehicle and client'
      USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION contract_vehicles_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM contracts c WHERE c.id = NEW.contract_id AND c.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'Only an ACTIVE contract can take vehicles'
        USING ERRCODE = 'DM005', TABLE = 'contract_vehicles', DETAIL = NEW.id::text;
    END IF;
    NEW.added_on := baku_date();
    RETURN NEW;
  END IF;
  IF OLD.removed_on IS NOT NULL
     OR NEW.removed_on IS NULL
     OR (to_jsonb(NEW) - 'removed_on' - 'removed_by' - 'remove_reason')
        <> (to_jsonb(OLD) - 'removed_on' - 'removed_by' - 'remove_reason') THEN
    RAISE EXCEPTION 'A contract vehicle is only removed, once; add a new row instead of editing'
      USING ERRCODE = 'DM005', TABLE = 'contract_vehicles', DETAIL = OLD.id::text;
  END IF;
  NEW.removed_on := baku_date();
  NEW.removed_by := current_actor();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER contract_vehicles_guard BEFORE INSERT OR UPDATE ON contract_vehicles
  FOR EACH ROW EXECUTE FUNCTION contract_vehicles_guard();
--> statement-breakpoint

-- Status events are evidence of payment and handover, so only the job_status_event
-- trigger may write them, not even the owner role by hand (verifier review of plan 02).
CREATE FUNCTION job_status_events_from_trigger() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'job_status_events are written only by the job_status_event trigger'
      USING ERRCODE = 'DM005', TABLE = 'job_status_events';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_status_events_from_trigger BEFORE INSERT ON job_status_events
  FOR EACH ROW EXECUTE FUNCTION job_status_events_from_trigger();
--> statement-breakpoint

-- Record the event for any update that changes the status, not only when `status`
-- is in the SET list.
CREATE OR REPLACE TRIGGER job_status_event_update AFTER UPDATE ON job_orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION job_status_event();

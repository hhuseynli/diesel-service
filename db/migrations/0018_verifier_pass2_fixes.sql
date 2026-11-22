-- Second verifier pass on plan 02:
-- * number_from_counter also checks the prefix belongs to the series, so a number
--   cannot be reused under another type's prefix;
-- * a corrected document version must follow an APPROVED or POSTED document of the
--   same type, with version + 1;
-- * the contract check is computed by the database (contract_check), which the job
--   guard and lib/contracts both use; a job can only be ON_CONTRACT with a contract
--   valid today;
-- * contracts that have ended (not ACTIVE, or past valid_to without auto-renew) take
--   no cars; a contract that has not started yet is not "ended";
-- * a job's formen and mechanic must hold their roles, also when changed later.

-- Prefixes as in lib/numbering/prefixes.ts (tests/db/numbering checks they agree).
CREATE FUNCTION series_prefix(series text) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE series
    WHEN 'QUSUR_AKTI' THEN 'QA' WHEN 'ELAVE_AKT' THEN 'EA' WHEN 'QIYMET_PROTOKOLU' THEN 'QP'
    WHEN 'TEHVIL_TESLIM' THEN 'TT' WHEN 'SATIS' THEN 'ST' WHEN 'ALIS' THEN 'AL'
    WHEN 'MEDAXIL' THEN 'MD' WHEN 'MEXARIC' THEN 'MX' WHEN 'SILINME' THEN 'SL'
    WHEN 'INVENTAR' THEN 'IN' WHEN 'JOB_ORDER' THEN 'IS'
  END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION number_from_counter(series text, number text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT number ~ '^[A-Z]{2}-[0-9]{4}-[0-9]{6}$'
     AND left(number, 2) = series_prefix(series)
     AND substr(number, 4, 4)::int = extract(year FROM baku_date())::int
     AND EXISTS (
       SELECT 1 FROM document_counters c
        WHERE c.doc_type = series
          AND c.year = substr(number, 4, 4)::int
          AND c.last_number >= right(number, 6)::int)
$$;
--> statement-breakpoint

-- Valid today: ACTIVE, started, and not ended unless it auto-renews (plan 02, C1).
CREATE FUNCTION contract_valid_today(p_contract uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT c.status = 'ACTIVE' AND c.valid_from <= baku_date()
     AND (c.valid_to IS NULL OR c.valid_to >= baku_date() OR c.auto_renew)
    FROM contracts c WHERE c.id = p_contract
$$;
--> statement-breakpoint

-- Ended: terminated, annulled, or past valid_to without auto-renew. Not yet started is not ended.
CREATE FUNCTION contract_ended(p_contract uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT c.status <> 'ACTIVE' OR coalesce(c.valid_to < baku_date() AND NOT c.auto_renew, false)
    FROM contracts c WHERE c.id = p_contract
$$;
--> statement-breakpoint

-- The intake contract check by vehicle (VIN), never by plate (spec 01, 3.3; plan 02).
CREATE FUNCTION contract_check(p_vehicle uuid, p_client uuid, OUT check_result text, OUT contract_id uuid)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  listed record;
BEGIN
  SELECT c.id, contract_valid_today(c.id) AS valid INTO listed
    FROM contract_vehicles cv JOIN contracts c ON c.id = cv.contract_id
   WHERE cv.vehicle_id = p_vehicle AND cv.removed_on IS NULL
     AND c.contragent_id = p_client AND c.status <> 'ANNULLED';
  IF FOUND THEN
    check_result := CASE WHEN listed.valid THEN 'ON_CONTRACT' ELSE 'CONTRACT_EXPIRED' END;
    contract_id := listed.id;
    RETURN;
  END IF;
  SELECT c.id INTO contract_id FROM contracts c
   WHERE c.contragent_id = p_client AND contract_valid_today(c.id)
   ORDER BY c.valid_from DESC LIMIT 1;
  check_result := CASE WHEN contract_id IS NOT NULL THEN 'NOT_ON_CONTRACT' ELSE 'NO_CONTRACT' END;
END;
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION series_prefix(text), contract_valid_today(uuid), contract_ended(uuid),
  contract_check(uuid, uuid) TO diesel_app;
--> statement-breakpoint

-- A job's formen holds FORMEN or OWNER, its mechanic MECHANIC (active roles).
CREATE FUNCTION job_staff_roles_ok(job job_orders) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = job.formen_id
                   AND r.role IN ('FORMEN', 'OWNER') AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'The job''s formen must hold the FORMEN or OWNER role'
      USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = job.id::text;
  END IF;
  IF job.mechanic_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM user_roles r WHERE r.user_id = job.mechanic_id
          AND r.role = 'MECHANIC' AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'The job''s mechanic must hold the MECHANIC role'
      USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = job.id::text;
  END IF;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION job_staff_roles_ok(job_orders) TO diesel_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION job_orders_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  computed record;
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
    -- The contract check is computed by the database, not taken from the app.
    SELECT * INTO computed FROM contract_check(NEW.vehicle_id, NEW.contragent_id);
    IF NEW.contract_check IS DISTINCT FROM computed.check_result
       OR NEW.contract_id IS DISTINCT FROM
          (CASE WHEN computed.check_result = 'ON_CONTRACT' THEN computed.contract_id END) THEN
      RAISE EXCEPTION 'Contract check must be % (contract %), as computed by contract_check()',
        computed.check_result, computed.contract_id
        USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = NEW.id::text;
    END IF;
    PERFORM job_staff_roles_ok(NEW);
    NEW.car_released := false;
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

  -- car_released is set by the database on handover and never changes otherwise.
  IF NEW.status = 'TEHVIL_VERILDI' AND OLD.status IS DISTINCT FROM 'TEHVIL_VERILDI' THEN
    NEW.car_released := true;
  ELSIF NEW.car_released IS DISTINCT FROM OLD.car_released THEN
    RAISE EXCEPTION 'car_released is set only by handover'
      USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;

  -- The recorded contract decision only changes when management resolves a hold.
  IF NEW.formen_id IS DISTINCT FROM OLD.formen_id OR NEW.mechanic_id IS DISTINCT FROM OLD.mechanic_id THEN
    PERFORM job_staff_roles_ok(NEW);
  END IF;

  IF NEW.contract_decision IS DISTINCT FROM OLD.contract_decision
     AND NOT (OLD.contract_decision IS NOT DISTINCT FROM 'HOLD_FOR_MANAGEMENT'
              AND NEW.contract_decision IS NOT DISTINCT FROM 'SEPARATE_PAID') THEN
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

CREATE OR REPLACE FUNCTION contract_vehicles_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF contract_ended(NEW.contract_id) IS NOT FALSE THEN
      RAISE EXCEPTION 'A contract that has ended takes no vehicles'
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

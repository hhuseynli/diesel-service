-- A job releases its car on handover (TEHVIL_VERILDI): car_released is set by the
-- database then and never changes. The one-open-job index (0016) ignores released jobs,
-- so a car handed over on deferred payment can come back before the old job is paid,
-- and the old job can still go ODENILDI -> BAGLANDI (plan 02, F23).
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

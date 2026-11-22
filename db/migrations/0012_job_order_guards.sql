-- Job orders, contracts and the job's status history (plan 02). Same conventions as
-- plan 01: explicit grants, no DELETE, actor and audit triggers, guards that hold for
-- the owner role too.

GRANT SELECT, INSERT, UPDATE ON contracts, contract_vehicles, job_orders TO diesel_app;
--> statement-breakpoint
GRANT SELECT ON job_status_events TO diesel_app;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contracts', 'contract_vehicles', 'job_orders'] LOOP
    EXECUTE format(
      'CREATE TRIGGER stamp_created BEFORE INSERT OR UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION stamp_created()', t);
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['contracts', 'contract_vehicles', 'job_orders', 'job_status_events'] LOOP
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
CREATE TRIGGER forbid_update BEFORE UPDATE ON job_status_events
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
--> statement-breakpoint

-- The job lifecycle (spec 00, section 4; plan 02, "Lifecycle").
CREATE FUNCTION job_orders_guard() RETURNS trigger
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
    -- The job keeps the VIN and plate the car had when it arrived (section 3a).
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
     OR NEW.plate_snapshot IS DISTINCT FROM OLD.plate_snapshot THEN
    RAISE EXCEPTION 'number, vehicle and snapshots of a job cannot change'
      USING ERRCODE = 'DM005', TABLE = 'job_orders', DETAIL = OLD.id::text;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
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

    -- Payment and handover happen once each, in either order; BAGLANDI needs both (plan 02, Q1).
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

-- Every status, recorded by the database rather than by app code (spec 00, section 4).
CREATE FUNCTION job_status_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO job_status_events (job_order_id, from_status, to_status, user_id, reason)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
    NEW.status,
    current_actor(),
    nullif(btrim(coalesce(current_setting('app.reason', true), '')), '')
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- A contract can be amended while ACTIVE (audited, with a reason); once terminated or
-- annulled it is frozen. It never moves to another client.
CREATE FUNCTION contracts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Contract % is % and cannot be changed', OLD.number, OLD.status
      USING ERRCODE = 'DM005', TABLE = 'contracts', DETAIL = OLD.id::text;
  END IF;
  IF NEW.contragent_id IS DISTINCT FROM OLD.contragent_id THEN
    RAISE EXCEPTION 'A contract cannot move to another client'
      USING ERRCODE = 'DM005', TABLE = 'contracts', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A contract vehicle row is only ever closed, once (plan 02).
CREATE FUNCTION contract_vehicles_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.removed_on IS NOT NULL
     OR NEW.removed_on IS NULL
     OR (to_jsonb(NEW) - 'removed_on' - 'removed_by' - 'remove_reason')
        <> (to_jsonb(OLD) - 'removed_on' - 'removed_by' - 'remove_reason') THEN
    RAISE EXCEPTION 'A contract vehicle is only removed, once; add a new row instead of editing'
      USING ERRCODE = 'DM005', TABLE = 'contract_vehicles', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A document on a job is about the job's vehicle (plan 01, F3 follow-up).
CREATE FUNCTION documents_job_vehicle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_vehicle uuid;
BEGIN
  IF NEW.job_order_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT j.vehicle_id INTO job_vehicle FROM job_orders j WHERE j.id = NEW.job_order_id;
  IF NEW.vehicle_id IS NULL THEN
    NEW.vehicle_id := job_vehicle;
  ELSIF NEW.vehicle_id <> job_vehicle THEN
    RAISE EXCEPTION 'A document on a job must be about the job''s vehicle'
      USING ERRCODE = 'DM005', TABLE = 'documents', DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER job_orders_guard BEFORE INSERT OR UPDATE ON job_orders
  FOR EACH ROW EXECUTE FUNCTION job_orders_guard();
--> statement-breakpoint
CREATE TRIGGER job_status_event_insert AFTER INSERT ON job_orders
  FOR EACH ROW EXECUTE FUNCTION job_status_event();
--> statement-breakpoint
CREATE TRIGGER job_status_event_update AFTER UPDATE OF status ON job_orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION job_status_event();
--> statement-breakpoint
CREATE TRIGGER contracts_guard BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION contracts_guard();
--> statement-breakpoint
CREATE TRIGGER contract_vehicles_guard BEFORE UPDATE ON contract_vehicles
  FOR EACH ROW EXECUTE FUNCTION contract_vehicles_guard();
--> statement-breakpoint
CREATE TRIGGER documents_job_vehicle BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_job_vehicle();

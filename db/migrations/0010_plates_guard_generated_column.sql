-- 0009's vehicle_plates_guard compared every column except status and valid_to, but in
-- a BEFORE trigger the generated column plate_normalized is still NULL in NEW, so every
-- legitimate update (ACTIVE -> ENDED) was refused. plate_normalized is derived from
-- plate_display, which is still compared, so leaving it out loses nothing.
CREATE OR REPLACE FUNCTION vehicle_plates_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'valid_to' - 'plate_normalized')
       <> (to_jsonb(OLD) - 'status' - 'valid_to' - 'plate_normalized')
     OR (OLD.status, NEW.status) NOT IN (
       ('ACTIVE', 'ENDED'), ('ACTIVE', 'UNCONFIRMED'), ('UNCONFIRMED', 'ENDED')) THEN
    RAISE EXCEPTION 'Plate history is never overwritten: only ACTIVE -> ENDED/UNCONFIRMED and UNCONFIRMED -> ENDED'
      USING ERRCODE = 'DM005', TABLE = 'vehicle_plates', DETAIL = OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;

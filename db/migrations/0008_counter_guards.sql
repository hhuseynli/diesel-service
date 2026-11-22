-- 1. stamp_created (as replaced in 0005) read OLD.id, which document_counters lacks:
--    changing created_* there failed with 42703 instead of DM005. Same fix as 0007.
-- 2. Gapless numbering no longer rests only on lib/numbering: a counter moves forward
--    by exactly one, and the app role can only start one at 1. The migration role may
--    start a counter elsewhere (continuing 1C numbering at cut-over).

CREATE OR REPLACE FUNCTION stamp_created() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by := current_actor();
  ELSE
    PERFORM current_actor();
    IF NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION '%.created_at and created_by cannot change', TG_TABLE_NAME
        USING ERRCODE = 'DM005', TABLE = TG_TABLE_NAME,
              DETAIL = coalesce(to_jsonb(OLD) ->> 'id', '');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION document_counters_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_number <> 1 AND session_user <> 'diesel_migrator' THEN
      RAISE EXCEPTION 'A new document counter starts at 1'
        USING ERRCODE = 'DM005', TABLE = 'document_counters';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.year IS DISTINCT FROM OLD.year
     OR NEW.last_number IS DISTINCT FROM OLD.last_number + 1 THEN
    RAISE EXCEPTION 'Document counters only move forward by one (lib/numbering assignNumber)'
      USING ERRCODE = 'DM005', TABLE = 'document_counters';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER document_counters_guard BEFORE INSERT OR UPDATE ON document_counters
  FOR EACH ROW EXECUTE FUNCTION document_counters_guard();

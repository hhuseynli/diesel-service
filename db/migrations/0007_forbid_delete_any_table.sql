-- 0005 read OLD.id directly, which fails with 42703 on document_counters (no id column)
-- instead of refusing with DM002. The row id is now read through to_jsonb.
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are never deleted; annul or deactivate instead', TG_TABLE_NAME
    USING ERRCODE = 'DM002', TABLE = TG_TABLE_NAME,
          DETAIL = CASE WHEN TG_LEVEL = 'ROW' THEN coalesce(to_jsonb(OLD) ->> 'id', '') ELSE '' END;
END;
$$;

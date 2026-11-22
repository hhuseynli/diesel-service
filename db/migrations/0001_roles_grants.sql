-- Privileges of the application role (plan 01, migration 0001; spec 00 section 5).
-- diesel_app never gets DELETE or TRUNCATE. audit_log is SELECT only: its rows are
-- written by SECURITY DEFINER functions. attachments are never updated.
-- Every new table must be granted explicitly in its own migration; there are no
-- default privileges, and tests/db/catalog.db.test.ts fails on anything broader.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO diesel_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON
  users, user_roles, contragents, vehicles, vehicle_plates,
  documents, document_lines, document_counters
TO diesel_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON settings, attachments TO diesel_app;
--> statement-breakpoint
GRANT SELECT ON audit_log TO diesel_app;
--> statement-breakpoint
-- Functions created from now on are not executable by everyone; each grant is explicit.
ALTER DEFAULT PRIVILEGES FOR ROLE diesel_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

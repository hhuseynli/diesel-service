#!/bin/bash
# Creates the two database roles and the application database.
# Runs once, when the dev container's data volume is first created.
# Production runs the same statements once by hand (see README), without CREATEDB.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_pw="$MIGRATOR_PASSWORD" -v app_pw="$APP_PASSWORD" <<'SQL'
-- Owns the schema and runs migrations. CREATEDB is for dev and CI test databases only.
CREATE ROLE diesel_migrator LOGIN CREATEDB PASSWORD :'migrator_pw';
-- The only role the application and the tests use. Privileges come from migrations.
CREATE ROLE diesel_app LOGIN NOINHERIT PASSWORD :'app_pw';

CREATE DATABASE diesel OWNER diesel_migrator;
REVOKE ALL ON DATABASE diesel FROM PUBLIC;
GRANT CONNECT ON DATABASE diesel TO diesel_app;
SQL

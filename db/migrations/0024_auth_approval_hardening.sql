-- Second verifier pass on plan 03:
-- * settings are written by the owner only (spec 00, section 10: "Manage users and
--   settings: owner"), or by migrations; approval rules fail closed when missing;
-- * a pending approval step cannot carry a decision; a rejection must be decided in the
--   same transaction that rejects the document, so it cannot be replayed;
-- * a successful sign-in attempt is the actor's own, so nobody else can reset a lock;
-- * a session belongs to its actor and lasts at most 12 hours.

CREATE FUNCTION settings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'diesel_migrator' AND NOT EXISTS (
       SELECT 1 FROM user_roles r
        WHERE r.user_id = current_actor() AND r.role = 'OWNER' AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Settings are changed by the owner'
      USING ERRCODE = 'DM007', TABLE = 'settings', DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER settings_guard BEFORE INSERT ON settings
  FOR EACH ROW EXECUTE FUNCTION settings_guard();
--> statement-breakpoint

-- Fails closed: a type without a rule (or no rules at all) cannot be approved by default.
CREATE OR REPLACE FUNCTION approval_rule(doc_type text) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  rule jsonb;
BEGIN
  SELECT s.value -> doc_type INTO rule
    FROM settings s
   WHERE s.key = 'approval_rules' AND s.effective_from <= now()
   ORDER BY s.effective_from DESC LIMIT 1;
  IF rule IS NULL OR jsonb_typeof(rule) <> 'array' THEN
    RAISE EXCEPTION 'No approval rule for %', doc_type USING ERRCODE = 'DM006';
  END IF;
  RETURN rule;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION approvals_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  doc record;
  actor uuid;
  expected text;
  latest_round int;
BEGIN
  SELECT d.status, d.created_by, d.type INTO doc FROM documents d WHERE d.id = NEW.document_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.method <> 'MANUAL' THEN
      RAISE EXCEPTION 'A new approval step is PENDING and MANUAL'
        USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = NEW.id::text;
    END IF;
    IF doc.status IS DISTINCT FROM 'SUBMITTED' THEN
      RAISE EXCEPTION 'Approval steps belong to a submitted document'
        USING ERRCODE = 'DM006', TABLE = 'approvals', DETAIL = NEW.id::text;
    END IF;
    -- The step is the rule's step: PAYMENT_CONFIRMER is the cashier or the bookkeeper.
    expected := approval_rule(doc.type) ->> (NEW.step_no - 1);
    IF expected IS NULL
       OR NOT (NEW.required_role = expected
               OR (expected = 'PAYMENT_CONFIRMER' AND NEW.required_role IN ('CASHIER', 'BOOKKEEPER'))) THEN
      RAISE EXCEPTION 'Step % of a % must be %', NEW.step_no, doc.type, coalesce(expected, 'absent')
        USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = NEW.id::text;
    END IF;
    -- Rounds follow one another; a new round starts only when the earlier one is closed;
    -- steps are added in order.
    SELECT coalesce(max(a.round), 0) INTO latest_round FROM approvals a WHERE a.document_id = NEW.document_id;
    IF NEW.round NOT IN (latest_round, latest_round + 1)
       OR (NEW.round = latest_round + 1 AND EXISTS (
             SELECT 1 FROM approvals a WHERE a.document_id = NEW.document_id AND a.status = 'PENDING'))
       OR NEW.step_no <> 1 + (SELECT count(*) FROM approvals a
                               WHERE a.document_id = NEW.document_id AND a.round = NEW.round) THEN
      RAISE EXCEPTION 'Approval steps are added round by round, in order'
        USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = NEW.id::text;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'A decided approval step cannot change'
      USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'comment')
     <> (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'comment') THEN
    RAISE EXCEPTION 'Only the decision of an approval step can change'
      USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  IF NEW.status = 'PENDING' THEN
    -- A pending step carries no decision: nothing about it changes until it is decided.
    IF to_jsonb(NEW) <> to_jsonb(OLD) THEN
      RAISE EXCEPTION 'A pending approval step changes only by being decided or cancelled'
        USING ERRCODE = 'DM005', TABLE = 'approvals', DETAIL = OLD.id::text;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    IF doc.status = 'SUBMITTED' AND NOT EXISTS (
         SELECT 1 FROM approvals a
          WHERE a.document_id = OLD.document_id AND a.round = OLD.round AND a.status = 'REJECTED') THEN
      RAISE EXCEPTION 'A step is cancelled only when its document has left SUBMITTED or its round was rejected'
        USING ERRCODE = 'DM006', TABLE = 'approvals', DETAIL = OLD.id::text;
    END IF;
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    RETURN NEW;
  END IF;

  -- APPROVED or REJECTED: a person decides, now, in order.
  IF doc.status IS DISTINCT FROM 'SUBMITTED'
     OR NEW.round <> (SELECT max(a.round) FROM approvals a WHERE a.document_id = NEW.document_id)
     OR EXISTS (SELECT 1 FROM approvals a
                 WHERE a.document_id = NEW.document_id AND a.round = NEW.round
                   AND a.step_no < NEW.step_no AND a.status <> 'APPROVED') THEN
    RAISE EXCEPTION 'Steps are decided in order, in the current round of a submitted document'
      USING ERRCODE = 'DM006', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  actor := current_actor();
  IF actor = doc.created_by OR actor = OLD.created_by THEN
    RAISE EXCEPTION 'A document cannot be approved or rejected by its creator or by whoever submitted it'
      USING ERRCODE = 'DM007', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  IF NEW.required_role = 'CLIENT' OR NOT EXISTS (
       SELECT 1 FROM user_roles r
        WHERE r.user_id = actor AND r.revoked_at IS NULL
          AND r.role IN (NEW.required_role, 'OWNER')) THEN
    RAISE EXCEPTION 'This step needs the % role', NEW.required_role
      USING ERRCODE = 'DM007', TABLE = 'approvals', DETAIL = OLD.id::text;
  END IF;
  NEW.decided_by := actor;
  NEW.decided_at := now();
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

  -- Only the approval engine approves or rejects (plan 03, A3).
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED' AND NOT document_round_approved(OLD.id, OLD.type) THEN
    RAISE EXCEPTION 'Document % is approved only when every step of its current approval round is approved',
      coalesce(OLD.number, OLD.id::text)
      USING ERRCODE = 'DM006', TABLE = 'documents', DETAIL = OLD.id::text;
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'REJECTED' AND NOT EXISTS (
       SELECT 1 FROM approvals a
        WHERE a.document_id = OLD.id AND a.status = 'REJECTED'
          AND a.round = (SELECT max(b.round) FROM approvals b WHERE b.document_id = OLD.id)
          -- decided in this transaction: an old rejection cannot be replayed
          AND a.decided_at = now()) THEN
    RAISE EXCEPTION 'Document % is rejected only through a rejected approval step', coalesce(OLD.number, OLD.id::text)
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

CREATE OR REPLACE FUNCTION login_attempts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.at := now();
  -- Nested IFs: current_actor() raises without an actor, and a failed attempt by an
  -- unknown phone has none.
  IF NEW.kind = 'UNLOCK' THEN
    IF NEW.recorded_by IS DISTINCT FROM current_actor()
       OR NOT EXISTS (SELECT 1 FROM user_roles r
                       WHERE r.user_id = NEW.recorded_by AND r.revoked_at IS NULL
                         AND r.role IN ('MANAGEMENT', 'OWNER')) THEN
      RAISE EXCEPTION 'An unlock is recorded by a manager acting in person'
        USING ERRCODE = 'DM007', TABLE = 'login_attempts', DETAIL = NEW.id::text;
    END IF;
  ELSIF NEW.success THEN
    -- A success resets the lock count, so it is only ever the signed-in person's own.
    IF NEW.user_id IS DISTINCT FROM current_actor() THEN
      RAISE EXCEPTION 'A successful sign-in is recorded by the person signing in'
        USING ERRCODE = 'DM007', TABLE = 'login_attempts', DETAIL = NEW.id::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION sessions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS DISTINCT FROM current_actor() THEN
      RAISE EXCEPTION 'A session belongs to the person who signed in'
        USING ERRCODE = 'DM007', TABLE = 'sessions', DETAIL = NEW.id::text;
    END IF;
    NEW.last_seen_at := now();
    NEW.expires_at := least(NEW.expires_at, now() + interval '12 hours');
    NEW.ended_at := NULL;
    NEW.end_reason := NULL;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'An ended session cannot change'
      USING ERRCODE = 'DM005', TABLE = 'sessions', DETAIL = OLD.id::text;
  END IF;
  IF (to_jsonb(NEW) - 'last_seen_at' - 'ended_at' - 'end_reason')
     <> (to_jsonb(OLD) - 'last_seen_at' - 'ended_at' - 'end_reason') THEN
    RAISE EXCEPTION 'Only last_seen_at and the end of a session can change'
      USING ERRCODE = 'DM005', TABLE = 'sessions', DETAIL = OLD.id::text;
  END IF;
  IF NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at THEN
    NEW.last_seen_at := now();
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END;
$$;

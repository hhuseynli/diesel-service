-- Spec-checker review of plan 03:
-- * approval steps must be the rule in settings: the right role at each step, in order,
--   one round after another; a round is approved only when it is complete;
-- * steps are cancelled only when their document has left SUBMITTED or the round was
--   rejected;
-- * neither the document's creator nor the round's submitter decides a step (AC3);
-- * an unlock is recorded by a manager in person; attempt times are server time;
-- * documents submitted before the engine (0020) get their approval round.

CREATE OR REPLACE FUNCTION document_round_approved(doc_id uuid, doc_type text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  WITH latest AS (
    SELECT max(a.round) AS round FROM approvals a WHERE a.document_id = doc_id
  )
  SELECT CASE
    WHEN (SELECT round FROM latest) IS NULL
      THEN jsonb_array_length(coalesce(approval_rule(doc_type), '[]'::jsonb)) = 0
    ELSE
      -- every step of the rule exists in the latest round, and all are approved
      (SELECT count(*) FROM approvals a, latest
        WHERE a.document_id = doc_id AND a.round = latest.round)
        = jsonb_array_length(coalesce(approval_rule(doc_type), '[]'::jsonb))
      AND NOT EXISTS (
        SELECT 1 FROM approvals a, latest
         WHERE a.document_id = doc_id AND a.round = latest.round AND a.status <> 'APPROVED')
  END
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

-- Attempts get server time; an unlock is a manager acting in person (plan 03, A7).
CREATE FUNCTION login_attempts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.at := now();
  IF NEW.kind = 'UNLOCK' AND (
       NEW.recorded_by IS DISTINCT FROM current_actor()
       OR NOT EXISTS (SELECT 1 FROM user_roles r
                       WHERE r.user_id = NEW.recorded_by AND r.revoked_at IS NULL
                         AND r.role IN ('MANAGEMENT', 'OWNER'))) THEN
    RAISE EXCEPTION 'An unlock is recorded by a manager acting in person'
      USING ERRCODE = 'DM007', TABLE = 'login_attempts', DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER login_attempts_guard BEFORE INSERT ON login_attempts
  FOR EACH ROW EXECUTE FUNCTION login_attempts_guard();
--> statement-breakpoint

-- Documents submitted before the engine existed get their first round. Sales are left
-- out: their second step needs the payment method; they are resubmitted with it.
SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000001', true);
--> statement-breakpoint
SELECT set_config('app.reason', 'audit.approvalRoundBackfill', true);
--> statement-breakpoint
INSERT INTO approvals (document_id, round, step_no, required_role)
SELECT d.id, 1, s.ordinality, s.role
  FROM documents d
  CROSS JOIN LATERAL jsonb_array_elements_text(approval_rule(d.type)) WITH ORDINALITY AS s(role, ordinality)
 WHERE d.status = 'SUBMITTED' AND d.type <> 'SATIS'
   AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.document_id = d.id)
 ORDER BY d.id, s.ordinality;
--> statement-breakpoint
SELECT set_config('app.user_id', '', true);
--> statement-breakpoint
SELECT set_config('app.reason', '', true);

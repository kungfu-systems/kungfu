-- SPDX-License-Identifier: Apache-2.0
-- Kungfu PostgreSQL Assignment transaction authority, protocol v1.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS kungfu_work;
REVOKE ALL ON SCHEMA kungfu_work FROM PUBLIC;

CREATE TABLE IF NOT EXISTS kungfu_work.authority_metadata (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    protocol text NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    authority text NOT NULL,
    installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (authority = 'kungfu-native-postgresql')
);

INSERT INTO kungfu_work.authority_metadata (
    singleton, protocol, schema_version, authority
) VALUES (
    true, 'kungfu.assignment-transaction/v1', 1, 'kungfu-native-postgresql'
)
ON CONFLICT (singleton) DO UPDATE
SET protocol = EXCLUDED.protocol,
    schema_version = EXCLUDED.schema_version,
    authority = EXCLUDED.authority
WHERE kungfu_work.authority_metadata.protocol = EXCLUDED.protocol
  AND kungfu_work.authority_metadata.schema_version = EXCLUDED.schema_version
  AND kungfu_work.authority_metadata.authority = EXCLUDED.authority;

CREATE TABLE IF NOT EXISTS kungfu_work.initiative (
    initiative_id text PRIMARY KEY,
    title text NOT NULL,
    intent text NOT NULL,
    source jsonb NOT NULL,
    source_version_root text NOT NULL,
    initiative_root text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (initiative_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
    CHECK (source_version_root ~ '^sha256:[0-9a-f]{64}$'),
    CHECK (initiative_root ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS kungfu_work.assignment (
    initiative_id text NOT NULL REFERENCES kungfu_work.initiative(initiative_id),
    assignment_id text NOT NULL,
    title text NOT NULL,
    work_definition jsonb NOT NULL,
    work_definition_root text NOT NULL,
    repository jsonb NOT NULL DEFAULT '{}'::jsonb,
    assignment_root text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (initiative_id, assignment_id),
    CHECK (assignment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
    CHECK (work_definition_root ~ '^sha256:[0-9a-f]{64}$'),
    CHECK (assignment_root ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS kungfu_work.assignment_head (
    initiative_id text NOT NULL,
    assignment_id text NOT NULL,
    phase text NOT NULL,
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_token_hash text,
    lease_holder text,
    lease_expires_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (initiative_id, assignment_id),
    FOREIGN KEY (initiative_id, assignment_id)
      REFERENCES kungfu_work.assignment(initiative_id, assignment_id),
    CHECK (phase IN (
      'admitted', 'claimed', 'executing', 'stage-ready',
      'completion-claimed', 'settled', 'cancelled'
    )),
    CHECK (
      (lease_token_hash IS NULL AND lease_holder IS NULL AND lease_expires_at IS NULL)
      OR
      (lease_token_hash ~ '^sha256:[0-9a-f]{64}$'
       AND lease_holder IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS kungfu_work.assignment_event (
    initiative_id text NOT NULL,
    assignment_id text NOT NULL,
    version bigint NOT NULL CHECK (version >= 0),
    event_type text NOT NULL,
    actor text NOT NULL,
    request_root text NOT NULL,
    payload jsonb NOT NULL,
    event_root text NOT NULL UNIQUE,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (initiative_id, assignment_id, version),
    FOREIGN KEY (initiative_id, assignment_id)
      REFERENCES kungfu_work.assignment(initiative_id, assignment_id),
    CHECK (request_root ~ '^sha256:[0-9a-f]{64}$'),
    CHECK (event_root ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS kungfu_work.assignment_evidence (
    initiative_id text NOT NULL,
    assignment_id text NOT NULL,
    evidence_root text NOT NULL,
    kind text NOT NULL,
    coordinates jsonb NOT NULL,
    event_root text NOT NULL REFERENCES kungfu_work.assignment_event(event_root),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (initiative_id, assignment_id, evidence_root),
    FOREIGN KEY (initiative_id, assignment_id)
      REFERENCES kungfu_work.assignment(initiative_id, assignment_id),
    CHECK (evidence_root ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS kungfu_work.command_receipt (
    idempotency_key text PRIMARY KEY,
    command_id text NOT NULL UNIQUE,
    request_root text NOT NULL,
    response jsonb NOT NULL,
    receipt_root text NOT NULL UNIQUE,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (request_root ~ '^sha256:[0-9a-f]{64}$'),
    CHECK (receipt_root ~ '^sha256:[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION kungfu_work.content_root(value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT 'sha256:' || encode(public.digest(convert_to(value::text, 'UTF8'), 'sha256'), 'hex')
$function$;

CREATE OR REPLACE FUNCTION kungfu_work.assignment_status(
    requested_initiative_id text,
    requested_assignment_id text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, kungfu_work
AS $function$
  SELECT jsonb_build_object(
    'schema', 'kungfu.assignment-transaction.status/v1',
    'authority', 'kungfu-native-postgresql',
    'initiativeId', a.initiative_id,
    'assignmentId', a.assignment_id,
    'title', a.title,
    'workDefinitionRoot', a.work_definition_root,
    'assignmentRoot', a.assignment_root,
    'repository', a.repository,
    'phase', h.phase,
    'version', h.version,
    'lease', CASE WHEN h.lease_token_hash IS NULL THEN NULL ELSE jsonb_build_object(
      'generation', h.lease_generation,
      'holder', h.lease_holder,
      'expiresAt', to_char(h.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) END,
    'evidence', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', e.kind,
        'root', e.evidence_root,
        'coordinates', e.coordinates,
        'eventRoot', e.event_root
      ) ORDER BY e.recorded_at, e.evidence_root)
      FROM kungfu_work.assignment_evidence e
      WHERE e.initiative_id = a.initiative_id
        AND e.assignment_id = a.assignment_id
    ), '[]'::jsonb)
  )
  FROM kungfu_work.assignment a
  JOIN kungfu_work.assignment_head h
    USING (initiative_id, assignment_id)
  WHERE a.initiative_id = requested_initiative_id
    AND a.assignment_id = requested_assignment_id
$function$;

CREATE OR REPLACE FUNCTION kungfu_work.assignment_list()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, kungfu_work
AS $function$
  SELECT jsonb_build_object(
    'schema', 'kungfu.assignment-transaction.list/v1',
    'authority', 'kungfu-native-postgresql',
    'assignments', COALESCE(jsonb_agg(
      kungfu_work.assignment_status(a.initiative_id, a.assignment_id)
      ORDER BY a.initiative_id, a.assignment_id
    ), '[]'::jsonb)
  )
  FROM kungfu_work.assignment a
$function$;

CREATE OR REPLACE FUNCTION kungfu_work.command(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, kungfu_work
AS $function$
DECLARE
    v_command_type text := request->>'commandType';
    v_command_id text := request->>'commandId';
    v_idempotency_key text := request->>'idempotencyKey';
    v_actor text := request->>'actor';
    v_initiative_id text := request#>>'{target,initiativeId}';
    v_assignment_id text := request#>>'{target,assignmentId}';
    v_arguments jsonb := COALESCE(request->'arguments', '{}'::jsonb);
    v_request_root text;
    existing_request_root text;
    existing_response jsonb;
    v_expected_version bigint;
    head kungfu_work.assignment_head%ROWTYPE;
    v_next_version bigint;
    v_next_phase text;
    v_event_payload jsonb;
    v_event_root text;
    v_response jsonb;
    v_receipt_root text;
    v_work_definition_root text;
    v_object_root text;
    v_token text;
    v_token_hash text;
    v_ttl_seconds integer;
    v_evidence jsonb;
    v_evidence_root text;
    v_evidence_kind text;
    v_merge_commit text;
BEGIN
    IF request IS NULL OR request->>'schema' <> 'kungfu.assignment-transaction.command/v1' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: schema';
    END IF;
    IF v_command_type IS NULL OR v_command_id IS NULL OR v_idempotency_key IS NULL
       OR v_actor IS NULL OR v_initiative_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: required identity';
    END IF;
    IF v_initiative_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
       OR (v_assignment_id IS NOT NULL
           AND v_assignment_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'malformed-identity';
    END IF;

    v_request_root := kungfu_work.content_root(request);
    PERFORM pg_advisory_xact_lock(hashtextextended(v_idempotency_key, 0));
    SELECT r.request_root, r.response
      INTO existing_request_root, existing_response
      FROM kungfu_work.command_receipt r
      WHERE r.idempotency_key = v_idempotency_key;
    IF FOUND THEN
      IF existing_request_root <> v_request_root THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'idempotency-conflict';
      END IF;
      RETURN existing_response;
    END IF;

    IF v_command_type = 'initiative.create' THEN
      IF v_assignment_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: initiative target';
      END IF;
      IF COALESCE(v_arguments->>'title', '') = ''
         OR COALESCE(v_arguments->>'intent', '') = ''
         OR jsonb_typeof(v_arguments->'source') <> 'object'
         OR COALESCE(v_arguments->>'sourceVersionRoot', '') !~ '^sha256:[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: initiative arguments';
      END IF;
      v_object_root := kungfu_work.content_root(jsonb_build_object(
        'initiativeId', v_initiative_id,
        'title', v_arguments->>'title',
        'intent', v_arguments->>'intent',
        'source', v_arguments->'source',
        'sourceVersionRoot', v_arguments->>'sourceVersionRoot'
      ));
      INSERT INTO kungfu_work.initiative (
        initiative_id, title, intent, source, source_version_root, initiative_root
      ) VALUES (
        v_initiative_id, v_arguments->>'title', v_arguments->>'intent',
        v_arguments->'source', v_arguments->>'sourceVersionRoot', v_object_root
      );
      v_response := jsonb_build_object(
        'schema', 'kungfu.assignment-transaction.receipt/v1',
        'authority', 'kungfu-native-postgresql',
        'commandId', v_command_id,
        'idempotencyKey', v_idempotency_key,
        'requestRoot', v_request_root,
        'disposition', 'applied',
        'initiativeId', v_initiative_id,
        'initiativeRoot', v_object_root
      );

    ELSIF v_command_type = 'assignment.create' THEN
      IF v_assignment_id IS NULL
         OR COALESCE(v_arguments->>'title', '') = ''
         OR jsonb_typeof(v_arguments->'workDefinition') <> 'object'
         OR jsonb_typeof(COALESCE(v_arguments->'repository', '{}'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: assignment arguments';
      END IF;
      PERFORM 1 FROM kungfu_work.initiative i WHERE i.initiative_id = v_initiative_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'initiative-not-found';
      END IF;
      v_work_definition_root := kungfu_work.content_root(v_arguments->'workDefinition');
      IF v_arguments ? 'workDefinitionRoot'
         AND v_arguments->>'workDefinitionRoot' <> v_work_definition_root THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'root-mismatch: work definition';
      END IF;
      v_object_root := kungfu_work.content_root(jsonb_build_object(
        'initiativeId', v_initiative_id,
        'assignmentId', v_assignment_id,
        'title', v_arguments->>'title',
        'workDefinitionRoot', v_work_definition_root,
        'repository', COALESCE(v_arguments->'repository', '{}'::jsonb)
      ));
      INSERT INTO kungfu_work.assignment (
        initiative_id, assignment_id, title, work_definition,
        work_definition_root, repository, assignment_root
      ) VALUES (
        v_initiative_id, v_assignment_id, v_arguments->>'title',
        v_arguments->'workDefinition', v_work_definition_root,
        COALESCE(v_arguments->'repository', '{}'::jsonb), v_object_root
      );
      INSERT INTO kungfu_work.assignment_head (
        initiative_id, assignment_id, phase, version
      ) VALUES (v_initiative_id, v_assignment_id, 'admitted', 0);
      v_event_payload := jsonb_build_object(
        'assignmentRoot', v_object_root,
        'workDefinitionRoot', v_work_definition_root,
        'phase', 'admitted'
      );
      v_event_root := kungfu_work.content_root(jsonb_build_object(
        'initiativeId', v_initiative_id, 'assignmentId', v_assignment_id,
        'version', 0, 'eventType', 'assignment-created',
        'actor', v_actor, 'requestRoot', v_request_root, 'payload', v_event_payload
      ));
      INSERT INTO kungfu_work.assignment_event (
        initiative_id, assignment_id, version, event_type, actor,
        request_root, payload, event_root
      ) VALUES (
        v_initiative_id, v_assignment_id, 0, 'assignment-created', v_actor,
        v_request_root, v_event_payload, v_event_root
      );
      v_response := jsonb_build_object(
        'schema', 'kungfu.assignment-transaction.receipt/v1',
        'authority', 'kungfu-native-postgresql',
        'commandId', v_command_id,
        'idempotencyKey', v_idempotency_key,
        'requestRoot', v_request_root,
        'disposition', 'applied',
        'initiativeId', v_initiative_id,
        'assignmentId', v_assignment_id,
        'assignmentRoot', v_object_root,
        'workDefinitionRoot', v_work_definition_root,
        'phase', 'admitted',
        'version', 0,
        'eventRoot', v_event_root
      );

    ELSE
      IF v_assignment_id IS NULL OR NOT (request ? 'expectedVersion')
         OR jsonb_typeof(request->'expectedVersion') <> 'number' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: expected version';
      END IF;
      v_expected_version := (request->>'expectedVersion')::bigint;
      SELECT * INTO head
      FROM kungfu_work.assignment_head h
      WHERE h.initiative_id = v_initiative_id
        AND h.assignment_id = v_assignment_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'assignment-not-found';
      END IF;
      IF head.version <> v_expected_version THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale-revision';
      END IF;

      IF v_command_type = 'assignment.lease.acquire' THEN
        IF head.phase IN ('settled', 'cancelled') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-transition: terminal assignment';
        END IF;
        v_ttl_seconds := COALESCE((v_arguments->>'ttlSeconds')::integer, 0);
        IF COALESCE(v_arguments->>'holder', '') = '' OR v_ttl_seconds < 1 OR v_ttl_seconds > 86400 THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: lease arguments';
        END IF;
        IF head.lease_expires_at IS NOT NULL AND head.lease_expires_at > clock_timestamp() THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'lease-required: active lease';
        END IF;
        v_token := gen_random_uuid()::text;
        v_token_hash := kungfu_work.content_root(to_jsonb(v_token));
        v_next_version := head.version + 1;
        v_next_phase := CASE WHEN head.phase = 'admitted' THEN 'claimed' ELSE head.phase END;
        UPDATE kungfu_work.assignment_head h SET
          phase = v_next_phase,
          version = v_next_version,
          lease_generation = head.lease_generation + 1,
          lease_token_hash = v_token_hash,
          lease_holder = v_arguments->>'holder',
          lease_expires_at = clock_timestamp() + make_interval(secs => v_ttl_seconds),
          updated_at = clock_timestamp()
        WHERE h.initiative_id = v_initiative_id
          AND h.assignment_id = v_assignment_id;
        SELECT * INTO head FROM kungfu_work.assignment_head h
        WHERE h.initiative_id = v_initiative_id
          AND h.assignment_id = v_assignment_id;
        v_event_payload := jsonb_build_object(
          'generation', head.lease_generation,
          'holder', head.lease_holder,
          'expiresAt', to_char(head.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'phase', head.phase
        );
        v_event_root := kungfu_work.content_root(jsonb_build_object(
          'initiativeId', v_initiative_id, 'assignmentId', v_assignment_id,
          'version', v_next_version, 'eventType', 'lease-acquired',
          'actor', v_actor, 'requestRoot', v_request_root, 'payload', v_event_payload
        ));
        INSERT INTO kungfu_work.assignment_event (
          initiative_id, assignment_id, version, event_type, actor,
          request_root, payload, event_root
        ) VALUES (
          v_initiative_id, v_assignment_id, v_next_version, 'lease-acquired', v_actor,
          v_request_root, v_event_payload, v_event_root
        );
        v_response := jsonb_build_object(
          'schema', 'kungfu.assignment-transaction.receipt/v1',
          'authority', 'kungfu-native-postgresql',
          'commandId', v_command_id,
          'idempotencyKey', v_idempotency_key,
          'requestRoot', v_request_root,
          'disposition', 'applied',
          'initiativeId', v_initiative_id,
          'assignmentId', v_assignment_id,
          'phase', head.phase,
          'version', head.version,
          'lease', jsonb_build_object(
            'generation', head.lease_generation,
            'token', v_token,
            'holder', head.lease_holder,
            'expiresAt', to_char(head.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ),
          'eventRoot', v_event_root
        );

      ELSE
        IF jsonb_typeof(request->'lease') <> 'object'
           OR COALESCE((request#>>'{lease,generation}')::bigint, -1) <> head.lease_generation
           OR kungfu_work.content_root(to_jsonb(request#>>'{lease,token}')) <> head.lease_token_hash
           OR head.lease_expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'generation-fenced';
        END IF;
        v_next_version := head.version + 1;
        v_next_phase := head.phase;

        IF v_command_type = 'assignment.phase.advance' THEN
          v_next_phase := v_arguments->>'toPhase';
          IF NOT ((head.phase = 'claimed' AND v_next_phase = 'executing')
               OR (head.phase = 'executing' AND v_next_phase = 'stage-ready')) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-transition';
          END IF;
          v_event_payload := jsonb_build_object(
            'fromPhase', head.phase, 'toPhase', v_next_phase,
            'reason', COALESCE(v_arguments->>'reason', '')
          );

        ELSIF v_command_type = 'assignment.checkpoint.append' THEN
          IF head.phase NOT IN ('claimed', 'executing', 'stage-ready')
             OR COALESCE(v_arguments->>'summary', '') = '' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: checkpoint';
          END IF;
          v_event_payload := jsonb_build_object(
            'phase', head.phase,
            'summary', v_arguments->>'summary',
            'coordinates', COALESCE(v_arguments->'coordinates', '{}'::jsonb)
          );

        ELSIF v_command_type = 'assignment.evidence.append' THEN
          v_evidence := v_arguments->'evidence';
          v_evidence_root := v_evidence->>'root';
          v_evidence_kind := v_evidence->>'kind';
          IF head.phase NOT IN ('executing', 'stage-ready')
             OR jsonb_typeof(v_evidence) <> 'object'
             OR COALESCE(v_evidence_kind, '') = ''
             OR COALESCE(v_evidence_root, '') !~ '^sha256:[0-9a-f]{64}$'
             OR jsonb_typeof(COALESCE(v_evidence->'coordinates', '{}'::jsonb)) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: evidence';
          END IF;
          v_event_payload := jsonb_build_object(
            'phase', head.phase, 'evidence', v_evidence
          );

        ELSIF v_command_type = 'assignment.completion.record' THEN
          IF head.phase <> 'stage-ready'
             OR jsonb_typeof(v_arguments->'evidenceRoots') <> 'array'
             OR jsonb_array_length(v_arguments->'evidenceRoots') = 0
             OR COALESCE(v_arguments->>'outcome', '') <> 'accepted' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-transition: completion';
          END IF;
          v_next_phase := 'completion-claimed';
          v_event_payload := jsonb_build_object(
            'fromPhase', head.phase, 'toPhase', v_next_phase,
            'outcome', 'accepted',
            'evidenceRoots', v_arguments->'evidenceRoots',
            'reason', COALESCE(v_arguments->>'reason', '')
          );

        ELSIF v_command_type = 'assignment.delivery.record' THEN
          v_merge_commit := v_arguments->>'mergeCommit';
          IF head.phase <> 'completion-claimed'
             OR COALESCE(v_merge_commit, '') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
             OR COALESCE(v_arguments->>'mergeRef', '') = '' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-transition: delivery';
          END IF;
          v_next_phase := 'settled';
          v_event_payload := jsonb_build_object(
            'fromPhase', head.phase, 'toPhase', v_next_phase,
            'mergeCommit', v_merge_commit,
            'mergeRef', v_arguments->>'mergeRef',
            'pullRequest', v_arguments->'pullRequest'
          );

        ELSE
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid-command: unsupported type';
        END IF;

        v_event_root := kungfu_work.content_root(jsonb_build_object(
          'initiativeId', v_initiative_id, 'assignmentId', v_assignment_id,
          'version', v_next_version, 'eventType', v_command_type,
          'actor', v_actor, 'requestRoot', v_request_root, 'payload', v_event_payload
        ));
        UPDATE kungfu_work.assignment_head h SET
          phase = v_next_phase,
          version = v_next_version,
          lease_token_hash = CASE WHEN v_next_phase = 'settled' THEN NULL ELSE h.lease_token_hash END,
          lease_holder = CASE WHEN v_next_phase = 'settled' THEN NULL ELSE h.lease_holder END,
          lease_expires_at = CASE WHEN v_next_phase = 'settled' THEN NULL ELSE h.lease_expires_at END,
          updated_at = clock_timestamp()
        WHERE h.initiative_id = v_initiative_id
          AND h.assignment_id = v_assignment_id;
        INSERT INTO kungfu_work.assignment_event (
          initiative_id, assignment_id, version, event_type, actor,
          request_root, payload, event_root
        ) VALUES (
          v_initiative_id, v_assignment_id, v_next_version, v_command_type, v_actor,
          v_request_root, v_event_payload, v_event_root
        );
        IF v_command_type = 'assignment.evidence.append' THEN
          INSERT INTO kungfu_work.assignment_evidence (
            initiative_id, assignment_id, evidence_root, kind, coordinates, event_root
          ) VALUES (
            v_initiative_id, v_assignment_id, v_evidence_root, v_evidence_kind,
            COALESCE(v_evidence->'coordinates', '{}'::jsonb), v_event_root
          );
        END IF;
        v_response := jsonb_build_object(
          'schema', 'kungfu.assignment-transaction.receipt/v1',
          'authority', 'kungfu-native-postgresql',
          'commandId', v_command_id,
          'idempotencyKey', v_idempotency_key,
          'requestRoot', v_request_root,
          'disposition', 'applied',
          'initiativeId', v_initiative_id,
          'assignmentId', v_assignment_id,
          'phase', v_next_phase,
          'version', v_next_version,
          'leaseGeneration', head.lease_generation,
          'eventRoot', v_event_root
        );
      END IF;
    END IF;

    v_receipt_root := kungfu_work.content_root(v_response);
    v_response := v_response || jsonb_build_object('receiptRoot', v_receipt_root);
    INSERT INTO kungfu_work.command_receipt (
      idempotency_key, command_id, request_root, response, receipt_root
    ) VALUES (
      v_idempotency_key, v_command_id, v_request_root, v_response, v_receipt_root
    );
    RETURN v_response;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity-conflict';
END
$function$;

REVOKE ALL ON ALL TABLES IN SCHEMA kungfu_work FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA kungfu_work FROM PUBLIC;

COMMIT;

-- Backfill api_duration_ms from stored transcripts: the value of the LAST parseable `result` event,
-- because the binary reports it cumulatively across a steered run's turns. Separate from 0181 so the
-- table-wide lock of ADD COLUMN is not held for the length of this scan. The CASE guards the cast:
-- AND gives no evaluation order, so a bare cast could run on a non-JSON line before the check.
-- Data-only and idempotent: a second run matches nothing.
UPDATE cli_invocations AS ci
SET api_duration_ms = found.api_ms
FROM (
  SELECT c.id,
    (SELECT (e.j ->> 'duration_api_ms')::numeric::integer
       FROM regexp_split_to_table(c.stream_log, E'\n') WITH ORDINALITY AS t(l, n)
       CROSS JOIN LATERAL (
         SELECT CASE
                  WHEN btrim(t.l, E' \t\r') LIKE '{%'
                   AND pg_input_is_valid(btrim(t.l, E' \t\r'), 'jsonb')
                  THEN btrim(t.l, E' \t\r')::jsonb
                END AS j
       ) AS e
      WHERE jsonb_typeof(e.j) = 'object'
        AND e.j ->> 'type' = 'result'
        AND jsonb_typeof(e.j -> 'duration_api_ms') = 'number'
      ORDER BY t.n DESC
      LIMIT 1) AS api_ms
  FROM cli_invocations AS c
  WHERE c.api_duration_ms IS NULL
    AND c.stream_log LIKE '%"duration_api_ms"%'
) AS found
WHERE ci.id = found.id
  AND found.api_ms IS NOT NULL;

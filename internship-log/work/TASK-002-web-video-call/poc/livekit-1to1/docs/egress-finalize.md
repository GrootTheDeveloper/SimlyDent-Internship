# R-egress-finalize

Async recording lifecycle: **Stop → Finalizing → (webhook|reconcile) → Ready/Failed**.

## Stop path

1. Staff `POST /api/calls/{id}/recording/stop`
2. Catalog `TryMarkFinalizing` (sets `finalizing_started_at` once)
3. Call UI `Stopping`
4. `RequestStopAsync` with `EGRESS_CONTROL_TIMEOUT_SECONDS` (default 8s)
5. Transport error → stay Finalizing + audit TransportError (**not** Failed)
6. Return immediately — no Materialize / COMPLETE poll

Call end uses the same short control request only.

## Ready path

`RecordingFinalizeService.ApplyEgressStatusAsync` (webhook + reconcile):

| Egress | Object | Result |
|--------|--------|--------|
| COMPLETE | exists | Ready |
| COMPLETE | missing | wait until `terminal_seen_at` + `RECORDING_FINALIZE_TIMEOUT_SECONDS` → Failed |
| LIMIT_REACHED | exists | Ready + `completion_reason=LimitReached` |
| FAILED / ABORTED | — | Failed (from active states only) |

Object check: local lab materializes `/out` → storage; S3 mode HeadObject only.

## Webhook

- `POST /api/livekit/webhook`
- Raw body → JWT Authorization + `sha256` claim → then deserialize
- LiveKit: `webhook.urls: [http://backend:8080/api/livekit/webhook]`

## Clocks (not `updated_at`)

- `finalizing_started_at` — first Finalizing
- `terminal_seen_at` — first COMPLETE/LIMIT_REACHED seen
- Reconcile never fails long `Recording` while Egress is ACTIVE

## Env

| Variable | Default |
|----------|---------|
| `EGRESS_CONTROL_TIMEOUT_SECONDS` | 8 |
| `RECORDING_FINALIZE_TIMEOUT_SECONDS` | 300 |
| `RECORDING_RECONCILE_SECONDS` | 30 |

## Non-goals (this PR)

Default `EGRESS_OUTPUT=s3`, presign, retention worker.

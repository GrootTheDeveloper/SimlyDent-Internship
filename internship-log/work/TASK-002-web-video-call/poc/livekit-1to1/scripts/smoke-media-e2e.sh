#!/usr/bin/env bash
# Continuous media smoke on VPS (staff A1↔A2). Run from poc/livekit-1to1 with .env loaded.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a
# shellcheck disable=SC1091
source .env
set +a
DOMAIN="${DOMAIN:?}"
PASS="${DEMO_PASSWORD:-Demo@123}"
ROUNDS="${1:-3}"

login() {
  curl -fsS -X POST "https://${DOMAIN}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"userId\":\"$1\",\"password\":\"${PASS}\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])'
}

json_field() {
  python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("'"$1"'","") or "")'
}

echo "=== smoke-media-e2e DOMAIN=${DOMAIN} rounds=${ROUNDS} ==="
echo "health: $(curl -fsS "https://${DOMAIN}/health")"

for r in $(seq 1 "$ROUNDS"); do
  echo
  echo "======== ROUND $r / $ROUNDS ========"
  T1=$(login A1)
  T2=$(login A2)
  echo "login ok A1/A2"

  # Heartbeat + ready so dispatch works
  curl -fsS -X POST "https://${DOMAIN}/api/agents/heartbeat" -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{}' >/dev/null || true
  curl -fsS -X POST "https://${DOMAIN}/api/agents/heartbeat" -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -d '{}' >/dev/null || true
  curl -fsS -X POST "https://${DOMAIN}/api/agents/ready" -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{}' >/dev/null || true
  curl -fsS -X POST "https://${DOMAIN}/api/agents/ready" -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -d '{}' >/dev/null || true

  CREATE=$(curl -sS -w "\n%{http_code}" -X POST "https://${DOMAIN}/api/calls" \
    -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
    -d '{"calleeId":"A2"}')
  CCODE=$(echo "$CREATE" | tail -n1)
  CBODY=$(echo "$CREATE" | sed '$d')
  echo "create call HTTP $CCODE"
  if [ "$CCODE" != "201" ] && [ "$CCODE" != "200" ]; then
    echo "$CBODY" | head -c 400; echo
    echo "SKIP round (create failed — agents busy?)"
    sleep 2
    continue
  fi
  CALL=$(echo "$CBODY" | json_field id)
  echo "call=$CALL"

  ACC=$(curl -sS -w "\n%{http_code}" -X POST "https://${DOMAIN}/api/calls/${CALL}/accept" \
    -H "Authorization: Bearer $T2")
  ACODE=$(echo "$ACC" | tail -n1)
  echo "accept HTTP $ACODE"

  curl -sS -X POST "https://${DOMAIN}/api/calls/${CALL}/recording/consent" \
    -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
    -d '{"status":"Granted"}' >/dev/null || true
  curl -sS -X POST "https://${DOMAIN}/api/calls/${CALL}/recording/consent" \
    -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' \
    -d '{"status":"Granted"}' >/dev/null || true
  echo "consent granted both"

  sleep 2
  # media assets after accept+consent
  docker exec livekit-1to1-postgres-1 psql -U simlydent -d simlydent -t -A -c \
    "SELECT kind||':'||status FROM media_assets WHERE call_id='${CALL}' ORDER BY requested_at;" || true

  # Dental clip with synthetic identity (A2 as peer) + fake track — expect 409 with clear msg if no track
  CLIP=$(curl -sS -w "\n%{http_code}" -X POST "https://${DOMAIN}/api/calls/${CALL}/video-clips/start" \
    -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
    -d '{"patientParticipantIdentity":"clinic-a:A2","patientVideoTrackSidHint":"TR_smoke"}')
  CLCODE=$(echo "$CLIP" | tail -n1)
  CLBODY=$(echo "$CLIP" | sed '$d')
  echo "clip start HTTP $CLCODE body=$(echo "$CLBODY" | head -c 200)"

  # Legacy video recording start
  curl -sS -X POST "https://${DOMAIN}/api/calls/${CALL}/recording/mode" \
    -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
    -d '{"mode":"Video"}' >/dev/null || true
  REC=$(curl -sS -w "\n%{http_code}" -X POST "https://${DOMAIN}/api/calls/${CALL}/recording/start" \
    -H "Authorization: Bearer $T1")
  RCODE=$(echo "$REC" | tail -n1)
  echo "recording/start HTTP $RCODE $(echo "$REC" | sed '$d' | head -c 160)"

  sleep 4
  END=$(curl -sS -w "\n%{http_code}" -X POST "https://${DOMAIN}/api/calls/${CALL}/end" \
    -H "Authorization: Bearer $T1")
  ECODE=$(echo "$END" | tail -n1)
  echo "end HTTP $ECODE"

  echo "wait finalize 25s..."
  sleep 25
  echo "--- media_assets for call ---"
  docker exec livekit-1to1-postgres-1 psql -U simlydent -d simlydent -c \
    "SELECT kind, status, left(coalesce(error,''),60) err FROM media_assets WHERE call_id='${CALL}' ORDER BY requested_at;"

  TM=$(login A-MGR)
  echo "--- consultations head ---"
  curl -sS -H "Authorization: Bearer $TM" "https://${DOMAIN}/api/consultations?limit=3" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); 
for i in d.get("items",[])[:3]:
 print(i.get("callId","")[:8], "audio",i.get("audioCount"), "video",i.get("videoCount"), "photo",i.get("photoCount"), i.get("status"))'

done

echo
echo "=== AGGREGATE media_assets ==="
docker exec livekit-1to1-postgres-1 psql -U simlydent -d simlydent -c \
  "SELECT kind, status, count(*) FROM media_assets GROUP BY 1,2 ORDER BY 1,2;"
echo "DONE smoke-media-e2e"

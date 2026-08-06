# TASK-003 Phase 0 — Clinic isolation evidence (VPS)

**Date:** 2026-08-06 13:53:10 +07:00
**API:** https://103.28.32.118.sslip.io
**Host:** root@103.28.32.118
**Baseline commits (local):** e510ea7, fa0e63c, 9d71338, deb4270

## Smoke test

```text

Test                                                                                                  Expected   Actual
----                                                                                                  --------   ------
POST /api/calls as anonymous                                                                               401      401
POST /api/calls with only X-User-Id (no Bearer)                                                            401      401
POST /api/calls as A1                                                                                      403      403
POST /api/calls as A1                                                                                      201      201
LiveKit room clinic namespace                                                        clinic:clinic-a:call:{id} ...562de
GET /api/calls/active as A2                                                                                200      200
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/token as A1                                           409      409
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/recording/start as A1                                 409      409
GET /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de as B1                                                  404      404
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/recording/start as B1                                 404      404
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/accept as A2                                          200      200
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/accept as A2                                          409      409
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/token as A1                                           200      200
LiveKit room/identity grants                                                                            scoped   scoped
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/quality/samples as B1                                 404      404
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/quality/samples as A1                                 202      202
GET /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/quality/summary as A2                                  200      200
Quality telemetry summary                                                                       sample + score ...score
Quality telemetry CSV export                                                               incoming + outgoing ...going
GET /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/quality/export?format=json as A2                       200      200
Quality telemetry JSON export                                                                 report + samples ...mples
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/end as A1                                             200      200
POST /api/calls/0fd79a98-3f2e-43d1-a2a0-e8dabf9562de/end as A1                                             409      409
POST /api/calls as A2                                                                                      201      201
POST /api/calls/c9a1333a-a75c-49e7-994f-68aeaef98a57/accept as A3                                          200      200
POST /api/calls as A1                                                                                      409      409
POST /api/calls/c9a1333a-a75c-49e7-994f-68aeaef98a57/end as A2                                             200      200


Smoke test passed: 27 checks (JWT Bearer auth + clinic isolation basics).
```

## Clinic isolation test (HTTP, SkipSignalR)

```text

Test                                                Expected                                              Actual       
----                                                --------                                              ------       
Health                                              200                                                   200          
A1 login clinic                                     clinic-a                                              clinic-a     
A2 login clinic                                     clinic-a                                              clinic-a     
B1 login clinic                                     clinic-b                                              clinic-b     
A1 JWT clinic_id claim                              clinic-a                                              clinic-a     
A1 directory HTTP                                   200                                                   200          
A1 directory has A2                                 A2 present                                            A1,A2,A3     
A1 directory no B1                                  B1 absent                                             A1,A2,A3     
B1 directory HTTP                                   200                                                   200          
B1 directory only clinic-b peers                    B1 only (no A*)                                       B1           
A1 presence HTTP                                    200                                                   200          
A1 presence clinic                                  clinic-a                                              clinic-a     
A1 presence no B1                                   B1 absent                                             A1,A2,A3,L...
B1 presence clinic                                  clinic-b                                              clinic-b     
B1 presence no A1                                   A1 absent                                             B1           
A1 presence ignores clinicId query                  clinic-a                                              clinic-a     
A1 cannot create call to B1 (body clinicId ignored) 403                                                   403          
A1 cannot create call to B1 (header spoof)          403                                                   403          
A1→A2 create                                        201                                                   201          
Room clinic-scoped                                  clinic:clinic-a:call:2d180cf2b2da441ba21dbbe5ae3cfd79 clinic:cli...
Call clinicId                                       clinic-a                                              clinic-a     
A2 can GET call                                     200                                                   200          
B1 GET call → 404                                   404                                                   404          
B1 accept → 404                                     404                                                   404          
B1 reject → 404                                     404                                                   404          
B1 cancel → 404                                     404                                                   404          
B1 end (ringing) → 404                              404                                                   404          
B1 media token (ringing) → 404                      404                                                   404          
B1 recording start (ringing) → 404                  404                                                   404          
B1 recording stop → 404                             404                                                   404          
B1 recording download → 404                         404                                                   404          
A2 accept                                           200                                                   200          
A1 media token                                      200                                                   200          
A2 media token                                      200                                                   200          
A1 LK sub                                           clinic-a:A1                                           clinic-a:A1  
A1 LK room exact                                    clinic:clinic-a:call:2d180cf2b2da441ba21dbbe5ae3cfd79 clinic:cli...
A2 LK sub                                           clinic-a:A2                                           clinic-a:A2  
A2 LK room exact                                    clinic:clinic-a:call:2d180cf2b2da441ba21dbbe5ae3cfd79 clinic:cli...
B1 media token after accept → 404                   404                                                   404          
B1 end after accept → 404                           404                                                   404          
B1 recording start after accept → 404               404                                                   404          
B1 recording file still 404                         404                                                   404          
A1 end call                                         200                                                   200          
Create ignores body clinicId/tenantId               clinic-a                                              clinic-a     
SignalR isolation                                   skipped                                               SkipSignalR  
SignalR group naming convention                     clinic:{id} / clinic:{id}:user:{uid}                  documented...


Clinic isolation passed: 46 checks.
```

## SignalR clinic probe (on VPS)

```text
Logging in A1/A2/B1 against https://103.28.32.118.sslip.io ...
Running SignalR probe via dotnet SDK container...
PASS signalr_clinic_isolated
```

## Result summary

| Suite | Result |
|-------|--------|
| smoke-test.ps1 | PASS |
| clinic-isolation-test.ps1 -SkipSignalR | PASS |
| signalr-clinic-probe.sh (VPS) | PASS |

Overall: PASS


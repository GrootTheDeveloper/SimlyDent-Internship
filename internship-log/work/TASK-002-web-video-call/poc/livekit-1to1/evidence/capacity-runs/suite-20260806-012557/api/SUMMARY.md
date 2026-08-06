# API load test report

- API: `http://localhost:5080`
- Hold: 6s per accepted call
- Busy rule (L03→busy L01): **PASS** — status=409 body={"error":"Caller or callee is busy."}
- Max concurrent pairs with **100% success**: **8**

| Pairs | Success | Rate % | Wall ms | total p50 | total avg | total max | LiveKit CPU% | Backend CPU% |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1/1 | 100 | 6387 | 6289 | 6289 | 6289 | 0.06 | 0.06 |
| 2 | 2/2 | 100 | 6305 | 6231 | 6249.5 | 6268 | 0.05 | 0.05 |
| 3 | 3/3 | 100 | 6288 | 6196 | 6204.7 | 6257 | 0.06 | 0.06 |
| 5 | 5/5 | 100 | 6290 | 6218 | 6215.8 | 6260 | 0.06 | 0.06 |
| 8 | 8/8 | 100 | 6361 | 6262 | 6277.6 | 6329 | 0.06 | 0.06 |

Artifacts: `api-load-report.json`, `api-load-pairs.csv`, `docker-stats.tsv`

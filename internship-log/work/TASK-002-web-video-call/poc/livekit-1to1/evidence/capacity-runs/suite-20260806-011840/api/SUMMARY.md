# API load test report

- API: `http://localhost:5080`
- Hold: 6s per accepted call
- Busy rule (L03→busy L01): **PASS** — status=409 body={"error":"Caller or callee is busy."}
- Max concurrent pairs with **100% success**: **8**

| Pairs | Success | Rate % | Wall ms | total p50 | total avg | total max | LiveKit CPU% | Backend CPU% |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1/1 | 100 | 6379 | 6219 | 6219 | 6219 | 0.05 | 0.05 |
| 2 | 2/2 | 100 | 6195 | 6131 | 6156.5 | 6182 | 0.07 | 0.07 |
| 3 | 3/3 | 100 | 6233 | 6181 | 6181 | 6202 | 0.13 | 0.13 |
| 5 | 5/5 | 100 | 6314 | 6231 | 6230.2 | 6280 | 0.06 | 0.06 |
| 8 | 8/8 | 100 | 6311 | 6248 | 6240.9 | 6264 | 0.05 | 0.05 |

Artifacts: `api-load-report.json`, `api-load-pairs.csv`, `docker-stats.tsv`

# API load test report

- API: `http://localhost:5080`
- Hold: 5s per accepted call
- Busy rule (L03→busy L01): **PASS** — status=409 body={"error":"Caller or callee is busy."}
- Max concurrent pairs with **100% success**: **20**

| Pairs | Success | Rate % | Wall ms | total p50 | total avg | total max | LiveKit CPU% | Backend CPU% |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10/10 | 100 | 5525 | 5373 | 5384 | 5418 | 0.05 | 0.05 |
| 15 | 15/15 | 100 | 5601 | 5469 | 5446.5 | 5530 | 0.07 | 0.07 |
| 20 | 20/20 | 100 | 5718 | 5539 | 5527.6 | 5652 | 0.07 | 0.07 |

Artifacts: `api-load-report.json`, `api-load-pairs.csv`, `docker-stats.tsv`

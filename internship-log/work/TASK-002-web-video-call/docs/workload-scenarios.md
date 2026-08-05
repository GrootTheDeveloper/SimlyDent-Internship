# Workload Scenarios and TCO Inputs — TASK-002

- Trạng thái: Input template; chưa có workload do stakeholder xác nhận
- Mục đích: tránh kết luận “rẻ/đắt” từ free tier hoặc số liệu giả định không có nguồn

## Input cần thu

| Biến | Đơn vị | Owner/source | Baseline | Peak | Growth |
|---|---|---|---|---|---|
| Nhân viên có quyền gọi | users | Product/operations | TBD | TBD | TBD |
| Concurrent calls | calls | Product/operations/telemetry | TBD | TBD | TBD |
| Calls per day | calls/day | Product/operations/telemetry | TBD | TBD | TBD |
| Average/P95 call duration | minutes | Telemetry hoặc business estimate có ngày | TBD | TBD | TBD |
| Working days/month | days | Operations | TBD | TBD | TBD |
| Branches/regions | count/location | Operations | TBD | TBD | TBD |
| Desktop/mobile mix | % calls | Telemetry/estimate có nguồn | TBD | TBD | TBD |
| Estimated TURN relay share | % participant time | PoC/production telemetry | TBD | TBD | TBD |
| Audio/video bitrate profile | bps/direction | PoC/config/source | TBD | TBD | TBD |
| Recording enabled | % calls | Optional R-06 decision | TBD | TBD | TBD |
| Recording retention | days | Product/legal/security | TBD | TBD | TBD |
| Availability/support target | target | Stakeholder/SLA | TBD | TBD | TBD |

Baseline/Peak/Growth là nhãn kịch bản; không được điền số tùy ý. Mỗi giá trị phải có owner, source/date và confidence/uncertainty nếu là estimate.

## Công thức chuẩn hóa

Ký hiệu:

- `C_d`: calls/day
- `D`: working days/month
- `M`: average call minutes
- `P`: participants/call; core 1:1 nên `P = 2`
- `R_turn`: tỷ lệ thời gian media qua TURN
- `B_turn`: tổng bitrate relay được tính phí, bytes/second theo topology/provider cụ thể
- `R_rec`: tỷ lệ call được record
- `S_rec`: recording storage bytes/minute theo output profile
- `retention_months`: thời gian giữ recording quy đổi theo tháng cho sensitivity model

```text
monthly_call_minutes = C_d × D × M
monthly_participant_minutes = monthly_call_minutes × P
monthly_turn_bytes = monthly_call_minutes × 60 × R_turn × B_turn
monthly_recording_minutes = monthly_call_minutes × R_rec
steady_state_recording_storage_bytes ≈ monthly_recording_minutes × S_rec × retention_months
```

`B_turn` không được tự suy ra chỉ từ một chiều bitrate: phải ghi rõ provider/topology tính ingress/egress và số luồng nào. Nếu bảng giá dùng participant-minute, connection-minute, egress GB hoặc subscription tier thì ánh xạ đúng đơn vị đó.

## Cost ledger

| Thành phần | Managed | Self-host/raw | Evidence cần có |
|---|---|---|---|
| License/subscription | Tier, included usage, overage | License/support contract nếu có | Pricing/quote ngày truy cập |
| Media/participant usage | Theo pricing unit | Compute/SFU capacity | Pricing + benchmark/config |
| TURN/network egress | Included hoặc tính riêng | Bandwidth/egress bill | Pricing + measured relay share |
| Recording | Minutes/output/egress/storage | Recorder compute + storage + egress | Optional R-06 pricing/config |
| Observability | Included/extra | Metrics/logging/alerting | Architecture + quote |
| Reliability | SLA/support tier | Redundancy, backup, on-call | SLA/ops plan |
| Engineering/operations | Integration/support | Build, patch, security, capacity, incident labor | Estimate có owner/rationale |

```text
managed_monthly_cost = fixed_tier + usage_charges + network_egress + optional_recording + support + taxes/fees_if_applicable
self_host_monthly_tco = compute + load_balancing + turn_bandwidth + storage + observability + backup/redundancy + engineering_operations + support
```

## Quy tắc kết luận

- Chưa có workload thì chỉ được trình bày cost drivers, công thức và sensitivity; chưa được chọn giải pháp theo TCO.
- Không dùng free tier làm estimate production.
- Mọi pricing/quote ghi currency, tax status, region và ngày truy cập.
- Không so managed bill với self-host compute bill nếu chưa tính operations/reliability cùng phạm vi.
- Recording cost chỉ xuất hiện trong optional R-06 scenario.

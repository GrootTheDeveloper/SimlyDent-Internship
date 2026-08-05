# PoC Metrics Schema — TASK-002

- Trạng thái: Protocol definition, chưa có dữ liệu
- Cơ sở metric WebRTC: [SRC-005 — W3C WebRTC Statistics](../references/source-log.md)
- Nguyên tắc: công bố raw observations, N, version và phương pháp; không so timestamp từ hai clock chưa đồng bộ.

## Timestamp và clock domain

| Field | Điểm ghi nhận | Clock domain | Metric dùng |
|---|---|---|---|
| `call_create_accepted_at` | Backend chấp nhận command tạo call | Server monotonic clock | Invitation latency |
| `callee_delivery_ack_at` | Backend/signaling nhận ACK rằng một eligible callee session đã nhận invitation | Cùng server monotonic clock hoặc cùng telemetry clock | Invitation latency |
| `accept_command_accepted_at` | Backend chấp nhận accept thắng race | Server monotonic clock | Audit/state only |
| `first_remote_audio_at_{endpoint}` | Endpoint quan sát remote audio bắt đầu phát/đủ điều kiện nghe theo instrumentation | Local monotonic clock của chính endpoint | First remote audio observation |
| `first_remote_video_frame_at_{endpoint}` | Endpoint render remote video frame đầu tiên theo instrumentation | Local monotonic clock của chính endpoint | First remote video observation |
| `local_connect_start_at_{endpoint}` | Endpoint vào `Connecting`: callee do local accept; caller do nhận authoritative accepted event | Cùng local monotonic clock của endpoint | Endpoint-local connecting-to-first-media proxy |
| `disconnect_detected_at_{endpoint}` | Endpoint phát hiện connection loss | Local monotonic clock | Reconnect duration |
| `media_restored_at_{endpoint}` | Cùng endpoint xác nhận remote media trở lại | Cùng local monotonic clock | Reconnect duration |

Không dùng `caller_time - callee_time` nếu không có cơ chế đồng bộ clock và sai số được ghi nhận.

## Metric definitions

| Metric | Định nghĩa vận hành | Báo cáo |
|---|---|---|
| `call_invitation_latency_ms` | `callee_delivery_ack_at - call_create_accepted_at` trong cùng clock domain | Raw từng run; ACK semantics/provider limitation phải ghi rõ |
| `connect_start_to_first_audio_ms_{endpoint}` | `first_remote_audio_at - local_connect_start_at` trên cùng endpoint | Hai chiều/từng endpoint; đây là proxy cục bộ, không tự gọi là end-to-end answer latency |
| `connect_start_to_first_video_ms_{endpoint}` | `first_remote_video_frame_at - local_connect_start_at` trên cùng endpoint | Hai chiều/từng endpoint; đây là proxy cục bộ |
| `answer_to_first_media_ms` | Chỉ tính khi accept và first-media được ghi trên cùng clock/trace domain hoặc có phương pháp đồng bộ kèm sai số | Nếu chưa có instrumentation hợp lệ, ghi U; không ghép server và client timestamps |
| `setup_success` | Run đạt `InCall` và có remote audio + remote video theo core expected result | Boolean + failure stage/reason |
| `setup_success_rate` | Số run `setup_success=true` / tổng số run hợp lệ trong đúng cell cấu hình | Numerator, denominator, excluded runs và lý do |
| `unexpected_disconnect_count` | Số lần rời `InCall` không do reject/cancel/hangup dự kiến | Count + reason/event evidence |
| `reconnect_duration_ms_{endpoint}` | `media_restored_at - disconnect_detected_at` trong cùng local clock; nếu không phục hồi ghi censored/fail | Raw từng event, timeout policy |
| `selected_candidate_path` | Candidate pair được chọn: host/srflx/relay theo stats khả dụng | Raw type/local/remote protocol đã làm sạch |
| `packet_loss` | Các counter/derived values từ stats; giữ tên field và timestamp gốc | Raw time series + công thức aggregation đã khóa |
| `jitter_s` | Giá trị jitter theo stats field liên quan | Raw time series; đổi đơn vị phải ghi công thức |
| `round_trip_time_s` | RTT từ stats object/candidate pair phù hợp khi có | Raw time series + stats object/source field |
| `bitrate_bps` | Delta bytes × 8 / delta time trên cùng stats stream | Raw series + interval |
| `frames_per_second` / resolution | Stats field hoặc rendered frames theo instrumentation | Raw series + track/direction |
| CPU/memory/battery | Tool/nền tảng đo, baseline, sampling và quyền phải xác định trước | Nếu không đo tái lập được, ghi U |

## Sampling và aggregation

- Sampling interval: **TBD trước khi test, kèm rationale và giới hạn của API/tool**.
- Warm-up/measurement window: **TBD trước khi test**.
- Số lần lặp N theo mỗi matrix cell: **TBD trước khi test, kèm rationale**.
- Luôn lưu raw series và N. Mean/median/percentile chỉ là dẫn xuất.
- Chỉ báo percentile khi sample size đủ cho mục đích đã nêu; nếu không, báo raw values/range và ghi hạn chế.
- Exclusion rule phải khóa trước; không loại outlier sau khi nhìn kết quả nếu protocol không quy định.

## Record schema cho mỗi run

```text
run_id
phase
candidate_name
candidate_sdk_server_version
commit_id
caller_identity / callee_identity
caller_device_os_browser_version
callee_device_os_browser_version
network_a / network_b
region / codec / media_profile / turn_policy
scenario_id
timestamp_fields_with_clock_domain
state_event_sequence_with_version
webrtc_stats_raw_path
functional_outcome
failure_stage / failure_reason
protocol_deviation
evidence_paths
```

## Chất lượng dữ liệu

- Missing metric phải ghi `missing` + nguyên nhân; không đổi thành 0.
- Run lỗi instrumentation được giữ trong log và đánh dấu invalid measurement, không âm thầm xóa.
- Secret, token, IP không cần thiết và PII phải được loại/mask trước khi lưu artifact.
- Metric so sánh chỉ hợp lệ khi scenario, version, media profile và network control tương đương hoặc sai khác đã được công bố.

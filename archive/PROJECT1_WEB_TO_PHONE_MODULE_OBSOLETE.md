# STATUS: OBSOLETE — DO NOT USE FOR TASK-002

> Tài liệu này được giữ chỉ để audit cách hiểu cũ Web-to-Phone/PSTN. Scope đã được sếp xác nhận là video call 1:1 giữa hai nhân viên cùng truy cập web. Tài liệu hiện hành: [PROJECT1_INTERNAL_VIDEO_CALL_MODULE.md](../PROJECT1_INTERNAL_VIDEO_CALL_MODULE.md) và [TASK-002](../internship-log/docs/06-tasks/TASK-002-research-web-video-call.md).

# PROJECT 1 — NGHIÊN CỨU MODULE GỌI ĐIỆN TỪ WEB TỚI KHÁCH HÀNG

**Tên đề xuất:** Web-to-Phone Calling Module  
**Bối cảnh:** Phòng khám sử dụng hệ thống web SimlyDent và cần gọi trực tiếp cho khách hàng từ danh sách khách hàng/lịch hẹn.  
**Phạm vi nghiên cứu:** Cuộc gọi thoại 1:1 từ trình duyệt tới số điện thoại di động, có ghi âm.  
**Giải pháp PoC đề xuất:** Stringee Call API/Web SDK.  
**Ngày cập nhật:** 2026-08-04

---

## 1. Yêu cầu gốc và cách hiểu sai ban đầu

Yêu cầu từ quản lý:

> “Project1: nghiên cứu cho anh cơ chế gọi video qua web. Xem giải pháp trước. Có demo càng tốt.”

Trong giai đoạn diễn giải yêu cầu ban đầu, người thực hiện đã hiểu bài toán
theo hướng:

- Cuộc gọi 1:1.
- Nhân viên phòng khám chủ động gọi.
- Nhân viên thao tác và nói chuyện ngay trên trình duyệt.
- Khách hàng nhận cuộc gọi bằng số điện thoại cá nhân.
- Không cần hình ảnh; chỉ cần thoại.
- Có nhu cầu ghi âm cuộc gọi.

Với cách hiểu ban đầu đó, tên kỹ thuật của bài toán sẽ là **Web-to-Phone Calling**,
**Browser Softphone** hoặc **WebRTC-to-PSTN**. Cách hiểu này **không còn là scope
TASK-002** sau khi sếp xác nhận lại: gọi video 1:1 giữa nhân viên trên web.

## 2. Mục tiêu

Cho phép nhân viên phòng khám:

1. Mở hồ sơ khách hàng hoặc lịch hẹn trên SimlyDent.
2. Bấm nút **Gọi** bên cạnh số điện thoại.
3. Sử dụng microphone/tai nghe của máy tính để nói chuyện.
4. Làm điện thoại của khách hàng đổ chuông như cuộc gọi thông thường.
5. Theo dõi trạng thái và kết quả cuộc gọi.
6. Ghi âm cuộc gọi nếu đã đáp ứng yêu cầu thông báo/đồng ý.
7. Tra cứu lịch sử và nghe lại recording theo đúng phân quyền.

## 3. Ngoài phạm vi

Phiên bản đầu không bao gồm:

- Video call.
- Gọi nhóm/conference.
- Khách phải cài ứng dụng.
- Tổng đài inbound, IVR, hàng đợi và phân phối agent phức tạp.
- Auto-dialer gọi hàng loạt.
- Speech-to-text, AI summary hoặc chấm điểm cuộc gọi.
- Tự xây dựng toàn bộ hạ tầng viễn thông/PBX.

Các tính năng này có thể được đánh giá ở giai đoạn sau.

## 4. Tính khả thi

Giải pháp khả thi. Trình duyệt truyền âm thanh qua WebRTC tới nhà cung cấp Voice API. Nhà cung cấp chuyển cuộc gọi sang mạng điện thoại PSTN/mobile để điện thoại khách hàng đổ chuông.

```text
[Nhân viên trên web SimlyDent]
           |
           | WebRTC audio
           v
[Stringee Call API / WebRTC-PSTN Gateway]
           |
           | Callout qua nhà mạng
           v
[Điện thoại cá nhân của khách hàng]
```

Khách hàng:

- Không cần tài khoản SimlyDent.
- Không cần cài ứng dụng.
- Không cần Internet.
- Chỉ cần nhận cuộc gọi như bình thường.

## 5. Vì sao cần Stringee hoặc dịch vụ tương đương

Trình duyệt không có SIM và không thể tự kết nối trực tiếp vào mạng Viettel, VinaPhone hoặc MobiFone. Stringee đóng vai trò cầu nối giữa WebRTC và mạng điện thoại.

Stringee phụ trách:

- Signaling và truyền âm thanh thời gian thực.
- Chuyển cuộc gọi từ Internet sang PSTN/mobile.
- Đầu số/caller ID gọi ra.
- Trạng thái cuộc gọi và webhook.
- Ghi âm và cung cấp recording ID/API.
- Xử lý codec, NAT và hạ tầng thoại.

SimlyDent vẫn tự quản lý:

- Giao diện và trải nghiệm người dùng.
- Danh sách khách hàng/lịch hẹn.
- Tài khoản, tenant và phân quyền.
- Quyền được phép gọi.
- Call log nghiệp vụ.
- Consent, retention và quyền truy cập recording.
- Báo cáo nghiệp vụ và audit.

## 6. Đầu số gọi ra

### Giai đoạn PoC

Sử dụng đầu số/cấu hình callout do Stringee cung cấp để thử nghiệm. Cần gọi tới số test được cho phép và kiểm tra số nào thực tế xuất hiện trên từng nhà mạng.

### Giai đoạn production

Có hai hướng:

1. **Caller ID dạng số:** khách thấy một số điện thoại đại diện cho phòng khám, ví dụ `0909090909`, nếu Stringee/nhà mạng xác minh và cho phép sử dụng số đó làm CLI.
2. **Voice Brandname:** khách thấy tên như `SIMLYDENT` thay cho số; đây là dịch vụ riêng, cần đăng ký thương hiệu và được nhà mạng phê duyệt.

Không được tự đặt tùy ý một số điện thoại trong trường `from`. Phải sử dụng số được cấp hoặc caller ID đã xác minh để tránh giả mạo số gọi.

Khuyến nghị dài hạn: mỗi phòng khám có một đầu số doanh nghiệp/hotline được quản lý trong hệ thống. Không nên phụ thuộc số SIM cá nhân của nhân viên.

## 7. Luồng nghiệp vụ chính

### 7.1. Trước cuộc gọi

1. Nhân viên đăng nhập SimlyDent.
2. Mở hồ sơ khách hàng hoặc lịch hẹn.
3. Hệ thống hiển thị số điện thoại đã che bớt tùy quyền.
4. Nhân viên bấm **Gọi**.
5. Backend kiểm tra tenant, vai trò, quyền gọi và trạng thái khách hàng.
6. Backend chuẩn hóa số về định dạng E.164, ví dụ `+84909090909`.
7. Backend cấp access token Stringee ngắn hạn cho browser.

### 7.2. Trong cuộc gọi

1. Browser xin quyền sử dụng microphone.
2. Web SDK tạo cuộc gọi app-to-phone.
3. Stringee gọi ra mạng điện thoại.
4. UI hiển thị `Connecting` → `Ringing` → `Answered`.
5. Nhân viên và khách nói chuyện hai chiều.
6. Nhân viên có thể mute hoặc kết thúc cuộc gọi.
7. Nếu recording được bật, hệ thống thực hiện flow thông báo/đồng ý đã duyệt.

### 7.3. Sau cuộc gọi

1. Stringee gửi event webhook về backend.
2. Backend cập nhật trạng thái cuối, thời lượng và nguyên nhân kết thúc.
3. Recording callback/ID được lưu nếu có.
4. Nhân viên chọn kết quả hoặc nhập ghi chú nghiệp vụ.
5. Call log được gắn với phòng khám, nhân viên, khách hàng và lịch hẹn.

## 8. Trạng thái cuộc gọi

Tối thiểu cần chuẩn hóa các trạng thái:

- `initiated`: đã gửi yêu cầu gọi.
- `connecting`: đang thiết lập kết nối.
- `ringing`: điện thoại khách đang đổ chuông.
- `answered`: khách đã nghe máy.
- `completed`: kết thúc bình thường.
- `busy`: máy bận.
- `no_answer`: không nghe máy.
- `rejected`: khách từ chối.
- `failed`: lỗi nhà cung cấp, số hoặc mạng.
- `cancelled`: nhân viên hủy trước khi kết nối.

Webhook có thể đến trùng hoặc không đúng thứ tự tuyệt đối; backend phải xử lý idempotent và không phụ thuộc hoàn toàn vào trạng thái trên browser.

## 9. Kiến trúc module

```text
┌─────────────────────────────────────────────────────────┐
│                    HỆ THỐNG SIMLYDENT                   │
│                                                         │
│  Customer/Appointment UI                               │
│       └─ Call button + embedded softphone              │
│                                                         │
│  Calling Module Backend                                │
│       ├─ Authorization & tenant isolation              │
│       ├─ Token service                                 │
│       ├─ Call orchestration                            │
│       ├─ Webhook handler                               │
│       ├─ Call log                                      │
│       ├─ Recording authorization                       │
│       └─ Provider adapter                              │
└──────────────────────────┬──────────────────────────────┘
                           │ SDK/API/Webhook
                           v
┌─────────────────────────────────────────────────────────┐
│                    STRINGEE PLATFORM                    │
│         WebRTC · PSTN gateway · recording · events     │
└──────────────────────────┬──────────────────────────────┘
                           │
                           v
                 MẠNG ĐIỆN THOẠI CỦA KHÁCH
```

### Provider adapter

Không để nghiệp vụ SimlyDent gọi trực tiếp Stringee ở mọi nơi. Tạo một interface trung gian:

```text
VoiceProvider
  issueClientToken(user, clinic)
  startCall(from, to, metadata)
  endCall(providerCallId)
  parseCallEvent(request)
  getRecording(recordingId)
  deleteRecording(recordingId)
```

Stringee là implementation đầu tiên. Thiết kế này giúp có thể đổi sang SIP trunk hoặc nhà cung cấp khác về sau.

## 10. Thiết kế frontend

### Vị trí nút gọi

- Danh sách khách hàng.
- Chi tiết khách hàng.
- Chi tiết lịch hẹn.
- Danh sách cần nhắc lịch/chăm sóc.

### Call panel

- Tên khách hàng.
- Số điện thoại được che/mở theo quyền.
- Số/brandname gọi ra.
- Trạng thái cuộc gọi và bộ đếm thời gian.
- Nút mute/unmute.
- Nút kết thúc.
- Thiết bị microphone đang sử dụng.
- Trạng thái recording.
- Lỗi và hướng xử lý ngắn gọn.

### Quy tắc UX

- Không cho gọi trùng cùng khách khi cuộc gọi trước chưa kết thúc.
- Cảnh báo nếu browser chưa có quyền microphone.
- Xác nhận khi gọi số chưa được chuẩn hóa hoặc ngoài phạm vi cho phép.
- Không tự động gọi ngay khi mở hồ sơ.
- Không hiển thị recording cho người không có quyền.

## 11. Backend/API nội bộ đề xuất

```text
POST /api/calling/token
POST /api/calls
POST /api/calls/{id}/hangup
GET  /api/calls/{id}
GET  /api/customers/{id}/calls
GET  /api/calls/{id}/recording
POST /api/webhooks/stringee/answer
POST /api/webhooks/stringee/events
POST /api/webhooks/stringee/recordings
```

API cụ thể có thể điều chỉnh theo kiến trúc hiện tại. Các nguyên tắc bắt buộc:

- Secret key chỉ nằm ở backend.
- Browser chỉ nhận token ngắn hạn và đúng quyền.
- Mỗi request gắn tenant/clinic rõ ràng.
- Webhook phải được xác thực và xử lý idempotent.
- Không cho frontend tự quyết định caller ID hoặc quyền recording.
- Không trả recording URL công khai lâu dài.

## 12. Dữ liệu cần lưu

Một bản ghi cuộc gọi tối thiểu gồm:

```text
Call
  id
  tenant_id
  clinic_id
  staff_user_id
  customer_id
  appointment_id (nullable)
  provider
  provider_call_id
  from_number
  to_number_masked / encrypted
  direction
  status
  initiated_at
  ringing_at
  answered_at
  ended_at
  duration_seconds
  end_reason
  recording_status
  recording_id
  consent_status
  consent_captured_at
  retention_until
  created_at / updated_at
```

Không nên lưu access token hoặc URL recording dài hạn ở dạng có thể truy cập công khai.

## 13. Recording, quyền riêng tư và pháp lý

Cuộc gọi giữa phòng khám và khách có thể chứa thông tin sức khỏe và dữ liệu cá nhân. Trước production cần có quy trình được pháp chế/DPO phê duyệt.

Yêu cầu tối thiểu:

- Thông báo rõ cuộc gọi được ghi âm.
- Ghi nhận trạng thái và thời điểm đồng ý.
- Xác định cách xử lý khi khách không đồng ý.
- Chỉ ghi âm đúng mục đích đã công bố.
- Phân quyền người được nghe/tải/xóa.
- Audit toàn bộ việc truy cập recording.
- Mã hóa dữ liệu khi truyền và khi lưu.
- Quy định thời hạn lưu và tự động xóa.
- Hỗ trợ xử lý yêu cầu truy cập/xóa của chủ thể dữ liệu.
- Xác minh vị trí lưu trữ và việc chuyển dữ liệu ra nước ngoài.
- Ký thỏa thuận xử lý dữ liệu phù hợp với nhà cung cấp.

Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 có hiệu lực từ 2026-01-01. Tài liệu này chỉ nêu yêu cầu kỹ thuật và không thay thế tư vấn pháp lý.

## 14. Bảo mật và chống lạm dụng

- RBAC cho quyền gọi, nghe recording và xuất dữ liệu.
- Tenant isolation tuyệt đối giữa các phòng khám.
- Access token ngắn hạn; không để secret Stringee ở frontend.
- Allowlist quốc gia/định dạng số được gọi.
- Rate limit theo user, phòng khám và IP.
- Hạn mức chi phí/ngày/tháng và cảnh báo bất thường.
- Chặn cuộc gọi hàng loạt hoặc gọi ngoài giờ nếu chưa được phép.
- Xác thực webhook, chống replay và lưu event ID.
- Audit ai gọi ai, lúc nào, từ phòng khám nào.
- Theo dõi đăng nhập bất thường và hành vi toll fraud.

## 15. Yêu cầu phi chức năng

### Khả dụng

- Có thông báo rõ khi Stringee hoặc microphone không sẵn sàng.
- Call log vẫn được đồng bộ lại từ webhook khi browser đóng bất ngờ.
- Lỗi gọi không được làm ảnh hưởng các chức năng khác của SimlyDent.

### Hiệu năng

- Thao tác bấm gọi phản hồi trên UI gần như tức thời.
- Theo dõi call setup time và thời gian tới trạng thái ringing.
- Không tải Web SDK trên mọi màn hình nếu người dùng không có quyền gọi.

### Tương thích

- Ưu tiên phiên bản hiện hành của Chrome và Edge desktop.
- Test microphone USB, Bluetooth và microphone tích hợp.
- Test mạng Wi‑Fi, LAN và mạng có firewall/proxy của phòng khám.

### Quan sát hệ thống

- Log theo correlation ID nội bộ và provider call ID.
- Metrics: số cuộc gọi, tỷ lệ kết nối, tỷ lệ bắt máy, P95 setup time, lỗi theo carrier, thời lượng, chi phí.
- Không ghi access token hoặc dữ liệu thoại vào application log.

## 16. PoC đề xuất

### Mục tiêu

Chứng minh được luồng thực tế:

> Nhân viên bấm gọi trên web → điện thoại +84 đổ chuông → thoại hai chiều → kết thúc → có call log và recording được bảo vệ.

### Phạm vi PoC

- Một tài khoản Stringee trial/test.
- Một trang web demo hoặc màn hình tích hợp nhỏ.
- Một user nhân viên.
- Một số gọi ra do Stringee cho phép.
- Ba số test có sự đồng ý, đại diện Viettel/VinaPhone/MobiFone.
- Có mute, hangup, trạng thái, thời lượng, recording và call log.
- Backend tạo access token và nhận webhook.

### Không dùng trong PoC

- Danh sách số lấy từ dữ liệu production.
- Gọi khách thật chưa đồng ý.
- Secret/token tạo thủ công ở frontend.
- Recording URL công khai.

## 17. Kịch bản kiểm thử PoC

### Chức năng

1. Gọi thành công tới từng nhà mạng.
2. Khách nghe rõ nhân viên và ngược lại.
3. Mute/unmute hoạt động.
4. Nhân viên và khách đều có thể kết thúc cuộc gọi.
5. Busy, reject, no-answer và invalid number hiển thị đúng.
6. Refresh/đóng tab không làm sai trạng thái cuối trong database.
7. Call log gắn đúng khách và lịch hẹn.
8. Recording được tạo và chỉ user có quyền nghe được.

### Mạng và thiết bị

- Wi‑Fi và LAN phòng khám.
- Có/không có VPN hoặc proxy.
- Đổi microphone trước cuộc gọi.
- Từ chối quyền microphone.
- Mất mạng giữa cuộc gọi.
- Tai nghe USB và Bluetooth.

### Bảo mật

- User phòng khám A không xem được call/recording của phòng khám B.
- Token hết hạn không sử dụng lại được.
- Không thể thay số gọi ra từ frontend.
- Webhook trùng không tạo bản ghi trùng.
- User không có quyền không gọi được.

## 18. Tiêu chí nghiệm thu PoC

PoC được xem là đạt khi:

- Browser gọi được tới số di động thật trên các carrier đã chọn.
- Có âm thanh hai chiều, không xuất hiện one-way audio trong kịch bản chuẩn.
- Trạng thái, thời gian bắt máy và thời lượng được lưu đúng.
- Xác định được caller ID thực tế khách nhìn thấy.
- Recording hoạt động theo flow consent thử nghiệm.
- Recording không truy cập được nếu không có quyền.
- Có bảng lỗi, chất lượng và chi phí thực tế.
- Có kết luận Go/No-Go cho Stringee.

## 19. Chi phí cần tính

Không chỉ so sánh giá SDK. Tổng chi phí gồm:

- Phí nền tảng/phút hoặc gói năm.
- Phí callout trả nhà mạng.
- Phí đầu số/caller ID.
- Phí Voice Brandname nếu sử dụng.
- Số kênh thoại đồng thời.
- Phí lưu trữ/tải recording nếu có.
- Chi phí phát triển, giám sát và hỗ trợ.

Theo bảng giá công khai hiện tại của Stringee, phí phần mềm tách khỏi phí callout nhà mạng; ghi âm voice được công bố không tính thêm phí phần mềm. Giá thực tế cần xác nhận bằng báo giá theo đầu số, lưu lượng và nhà mạng trước khi quyết định production.

## 20. Rủi ro và biện pháp

| Rủi ro | Ảnh hưởng | Hướng xử lý |
|---|---|---|
| Caller ID không đúng kỳ vọng | Khách không nhận diện phòng khám | Xác minh đầu số bằng văn bản và test cả ba carrier |
| Bị gắn nhãn spam | Tỷ lệ bắt máy thấp | Dùng đầu số doanh nghiệp/Voice Brandname, kiểm soát tần suất |
| Chất lượng mạng phòng khám kém | Âm thanh giật hoặc một chiều | Network test, tai nghe chuẩn, telemetry và hướng dẫn IT |
| Lộ recording | Rủi ro dữ liệu cá nhân | RBAC, encryption, audit, URL ngắn hạn, retention |
| Lạm dụng gọi quốc tế/hàng loạt | Tăng chi phí hoặc vi phạm | Allowlist, quota, rate limit, alert và approval |
| Phụ thuộc Stringee | Khó đổi nhà cung cấp | Provider adapter và lưu call ID nội bộ độc lập |
| Webhook thiếu/trùng | Call log sai | Idempotency, retry, reconciliation API/job |
| Quy trình consent chưa rõ | Rủi ro pháp lý | Pháp chế phê duyệt trước khi bật recording production |

## 21. Lộ trình đề xuất

### Giai đoạn 1 — Research và vendor validation

Thời lượng dự kiến: 1–2 ngày làm việc.

- Chốt câu hỏi với Stringee về caller ID, carrier, recording, vùng dữ liệu, SLA và giá callout.
- Tạo tài khoản thử nghiệm.
- Xác nhận điều kiện đầu số và Voice Brandname.

### Giai đoạn 2 — PoC kỹ thuật

Thời lượng dự kiến: 2–4 ngày làm việc.

- Demo frontend softphone tối thiểu.
- Backend token và webhook.
- Gọi số thật có kiểm soát.
- Recording và call log.
- Báo cáo test/cost ban đầu.

### Giai đoạn 3 — Đánh giá Go/No-Go

- Demo cho quản lý.
- Chốt độ ổn định, caller ID và chi phí.
- So sánh Stringee với SIP trunk hoặc vendor thứ hai nếu cần.
- Chốt phạm vi production.

### Giai đoạn 4 — Production hóa

Ước lượng chỉ thực hiện sau PoC, vì phụ thuộc hệ thống hiện tại, pháp lý, đầu số và quy mô tenant. Các đầu việc chính:

- Tích hợp UI thật.
- Multi-tenant/RBAC/audit.
- Consent và retention.
- Monitoring, quota và reconciliation.
- Quy trình hỗ trợ và xử lý sự cố.
- Security review, load test và rollout có kiểm soát.

## 22. Câu hỏi phải xác nhận với Stringee

1. Có thể dùng số di động đang sở hữu, ví dụ `0909090909`, làm outbound caller ID không?
2. Quy trình xác minh số và hồ sơ cần thiết là gì?
3. Nếu không dùng được số hiện có, Stringee cấp loại đầu số nào?
4. Caller ID hoạt động thế nào tới Viettel, VinaPhone và MobiFone?
5. Có hỗ trợ Voice Brandname `SIMLYDENT` không? Phạm vi carrier và chi phí?
6. Phí callout nội/ngoại mạng và block tính cước?
7. Recording lưu ở đâu, định dạng gì, bao lâu và có API xóa không?
8. Dữ liệu/recording có được chuyển ra ngoài Việt Nam không?
9. Cơ chế xác thực webhook và retry như thế nào?
10. SLA, giới hạn kênh đồng thời và rate limit?
11. Có công cụ chống toll fraud và giới hạn ngân sách không?
12. Điều kiện sử dụng cho lĩnh vực phòng khám/y tế?

## 23. Deliverable cho Project 1

1. Tài liệu nghiên cứu và kiến trúc giải pháp.
2. Bảng đánh giá Stringee và các rủi ro.
3. Demo web-to-phone 1:1 có call status.
4. Demo recording có kiểm soát truy cập.
5. Kết quả test thực tế theo carrier/network/caller ID.
6. Ước tính chi phí dựa trên báo giá và dữ liệu PoC.
7. Kết luận Go/No-Go và backlog production.

## 24. Mức độ đáp ứng yêu cầu của quản lý

| Yêu cầu | Cách đáp ứng |
|---|---|
| Nghiên cứu cơ chế gọi qua web | Phân tích WebRTC-to-PSTN và kiến trúc module |
| Xem giải pháp trước | Chọn Stringee làm ứng viên chính, có phương án thay thế |
| Có demo càng tốt | PoC browser gọi tới số điện thoại thật |
| Có thể ghép hệ thống hiện tại | Tách frontend softphone, backend service và provider adapter |
| Direct call 1:1 | Một nhân viên gọi một khách từ hồ sơ/lịch hẹn |
| Recording | Có thiết kế consent, recording callback, RBAC và retention |

## 25. Kết luận và đề xuất quyết định

Project khả thi và phù hợp để triển khai dưới dạng một module tích hợp vào SimlyDent.

Đề xuất hiện tại:

> **Go với PoC Stringee Call API cho cuộc gọi thoại 1:1 từ web tới số điện thoại, có trạng thái, call log và recording.**

Chưa cam kết production cho tới khi PoC xác minh được bốn yếu tố:

1. Caller ID/đầu số khách nhìn thấy.
2. Khả năng kết nối và chất lượng trên các nhà mạng Việt Nam.
3. Chi phí thực tế trên mỗi phút/cuộc gọi.
4. Recording, vị trí dữ liệu và quy trình consent đáp ứng yêu cầu pháp lý.

---

## Nguồn tham khảo chính thức

- Stringee Web SDK — web-to-phone: https://developer.stringee.com/docs/getting-started-stringee-web-sdk
- Stringee Call API overview: https://developer.stringee.com/docs/call-api-overview
- Stringee Call REST API: https://developer.stringee.com/docs/call-rest-api
- Stringee Call API pricing: https://stringee.com/vi/pricing-call
- Stringee Call API product page: https://stringee.com/vi/call
- VNPT Voice Brandname: https://vnpt.vn/doanh-nghiep/san-pham-dich-vu/cuoc-goi-thuong-hieu-voice-brandname/
- Viettel Voice Brandname: https://www.viettel.vn/voice-brand
- Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15: https://vanban.chinhphu.vn/?classid=1&docid=214590&pageid=27160&typegroup=

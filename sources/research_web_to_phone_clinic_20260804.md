# STATUS: OBSOLETE FOR TASK-002 — WEB-TO-PHONE SCOPE WAS REJECTED

> Giữ làm audit trail cho cách hiểu cũ. Project 1 hiện hành là video call 1:1 giữa hai nhân viên cùng truy cập web: [TASK-002](../internship-log/docs/06-tasks/TASK-002-research-web-video-call.md).

# Project 1 — Research: module gọi từ web của phòng khám tới số điện thoại khách hàng

Ngày nghiên cứu: 2026-08-04  
Phạm vi đã chốt từ yêu cầu: 1:1, nhân viên phòng khám gọi trực tiếp từ trình duyệt, khách nhận cuộc gọi trên số điện thoại cá nhân, có ghi âm.

## 1. Kết luận quan trọng nhất

Yêu cầu này không phải là “video call qua web” theo nghĩa hai bên cùng nhìn thấy hình. Đây là bài toán **browser softphone / WebRTC-to-PSTN**:

1. Nhân viên phòng khám nói qua microphone của trình duyệt.
2. Nhà cung cấp CPaaS/VoIP chuyển cuộc gọi từ WebRTC sang mạng điện thoại PSTN/mobile.
3. Khách nhận cuộc gọi thoại bằng ứng dụng Điện thoại mặc định trên máy.
4. Việc ghi âm diễn ra trên hạ tầng voice/bridge của nhà cung cấp.

Một số điện thoại thông thường không có kênh video. Nếu bắt buộc có hình, khách phải mở một đường link/app để tham gia phòng WebRTC; có thể gửi link qua SMS/Zalo trước hoặc trong lúc gọi thoại.

Tên scope nên dùng khi báo cáo:

> Web-to-Phone Calling Module — cuộc gọi thoại 1:1 từ trình duyệt tới số điện thoại, có ghi âm.

Nếu sếp vẫn yêu cầu video, tách thành scope thứ hai:

> Browser-to-Browser Video Call — khách tham gia qua secure link, không gọi video trực tiếp vào số điện thoại.

## 2. Kiến trúc đề xuất

```text
[Web hiện có của phòng khám]
  UI softphone + WebRTC audio
          |
          | access token ngắn hạn
          v
[Backend module của hệ thống]
  quyền gọi, khách hàng, webhook, call log,
  consent, metadata recording, audit
          |
          | SDK/API + signed webhook
          v
[CPaaS / WebRTC-PSTN gateway]
  signaling, media bridge, recording
          |
          v
[Mạng di động/PSTN] ---> [Số điện thoại của khách]
```

Không nên dùng LiveKit/Jitsi/raw WebRTC một mình cho scope này. Các công nghệ đó giải quyết media giữa các client Internet; muốn quay số điện thoại vẫn phải có SIP trunk/PSTN gateway, số gọi ra và cước nhà mạng.

## 3. Shortlist giải pháp

### Ưu tiên PoC: Stringee Call API

Lý do:

- Tài liệu chính thức nêu rõ Web SDK hỗ trợ web-to-phone và có WebPhone mẫu.
- Có JavaScript SDK phía browser, JWT/access token từ backend, `answer_url` để điều khiển luồng gọi và `event_url` để nhận trạng thái.
- Có call log, record/store call và API tải recording.
- Có hoạt động và bảng giá bằng VND tại Việt Nam; phí phần mềm tách khỏi phí callout nhà mạng.
- Trang giá hiện tại có gói dùng thử và ghi âm voice không tính thêm phí phần mềm, nhưng vẫn phải xác minh phí nhà mạng, đầu số/caller ID, lưu trữ và điều khoản thương mại trước khi chốt.

Rủi ro/câu hỏi cần hỏi sales hoặc thử trực tiếp:

- Khách sẽ thấy số nào khi nhận cuộc gọi? Có cấp/định danh số Việt Nam không?
- Tỷ lệ kết nối tới Viettel/VinaPhone/MobiFone và xử lý spam labeling thế nào?
- Recording lưu ở đâu, bao lâu, có API xóa, mã hóa và chọn vùng dữ liệu không?
- SLA, số kênh đồng thời, giới hạn tốc độ, cơ chế chống gian lận và chi phí callout thực tế.

### Benchmark quốc tế: Twilio Programmable Voice

- Voice JavaScript SDK biến trình duyệt thành softphone và có thể nối ra PSTN.
- Recording, webhook, dual-channel và encryption được tài liệu hóa tốt.
- Không phù hợp để mặc định chọn cho Việt Nam khi chưa thử thực tế: hướng dẫn quốc gia hiện nêu không có số local Việt Nam, domestic reachability không hỗ trợ; outbound quốc tế tới Việt Nam có, còn caller ID +84 đăng ký là best-effort.
- Dùng làm benchmark về API, security và observability; chỉ chọn production nếu bài test caller ID/reachability/cước đạt yêu cầu.

### Phương án phụ: Telnyx hoặc Vonage

- Cả hai có SDK/use case browser-to-phone.
- Cần kiểm chứng riêng về số Việt Nam, caller ID, cước, dữ liệu ghi âm và hỗ trợ địa phương trước khi đưa vào shortlist cuối.

### Phương án tự host

SIP/PBX như Asterisk/FreeSWITCH kết hợp SIP trunk có thể kiểm soát sâu hơn nhưng làm tăng mạnh phạm vi vận hành: SBC/NAT, codec, bảo mật SIP, chống toll fraud, routing, recording, monitoring và hợp đồng với nhà mạng. Không nên là PoC đầu tiên nếu mục tiêu của sếp là “xem giải pháp trước, có demo càng tốt”.

## 4. Module ghép vào hệ thống có sẵn

### Frontend

- Nút “Gọi khách” trên hồ sơ/lịch hẹn.
- Hiển thị số đã che bớt, trạng thái: connecting, ringing, answered, ended, busy, no-answer, failed.
- Mute, hang up, chọn microphone, kiểm tra quyền microphone.
- Banner “Cuộc gọi đang được ghi âm”.
- Không chứa API secret; chỉ nhận access token ngắn hạn từ backend.

### Backend

- `POST /calls/token`: cấp token ngắn hạn theo user/phòng khám/quyền.
- `POST /calls`: kiểm tra quyền, chuẩn hóa số E.164, tạo call context.
- `POST /webhooks/call-events`: nhận và xác thực trạng thái cuộc gọi.
- `POST /webhooks/recordings`: nhận recording ID/status; không tin URL do client gửi.
- `GET /calls/{id}` và `GET /calls/{id}/recording`: kiểm tra quyền trước khi trả dữ liệu/stream.
- Lưu mapping: tenant/clinic, staff, customer, appointment, provider call ID, timestamps, outcome, consent, recording ID, retention deadline.

### Ranh giới module

Module chỉ cung cấp adapter ổn định cho hệ thống chính. SDK cụ thể của vendor nằm sau interface như `createCall`, `hangup`, `mute`, `getStatus`, `getRecording`. Thiết kế này cho phép đổi Stringee/Twilio/SIP provider mà không viết lại màn hình nghiệp vụ.

## 5. Recording và dữ liệu cá nhân

Đây là dữ liệu liên quan khách hàng/phòng khám và có thể chứa thông tin sức khỏe. Tối thiểu cần:

- Thông báo rõ trước khi bắt đầu ghi âm và lưu bằng chứng đồng ý/thời điểm đồng ý.
- Có phương án không ghi âm hoặc kết thúc cuộc gọi nếu khách không đồng ý, tùy mục đích nghiệp vụ và tư vấn pháp lý.
- Phân quyền theo tenant và vai trò; không để recording URL công khai hoặc token dài hạn trên browser.
- Mã hóa khi truyền/lưu; audit ai nghe/tải/xóa.
- Chính sách thời hạn lưu, xóa, trích xuất và xử lý yêu cầu của chủ thể dữ liệu.
- Đánh giá vị trí lưu trữ/chuyển dữ liệu ra nước ngoài và hợp đồng xử lý dữ liệu với vendor.
- Xác thực chữ ký webhook, chống replay, chống gọi trái phép/toll fraud, giới hạn số/cuộc gọi.

Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 có hiệu lực từ 2026-01-01. Phần triển khai recording cần được pháp chế/DPO xác nhận; tài liệu này không phải tư vấn pháp lý.

## 6. PoC nên demo những gì

### Happy path

1. Nhân viên đăng nhập hệ thống trên Chrome/Edge.
2. Mở hồ sơ khách, bấm “Gọi”.
3. Backend cấp token ngắn hạn và cho phép quay số +84.
4. Điện thoại thật của khách đổ chuông, hiển thị caller ID hợp lệ.
5. Hai bên nói chuyện hai chiều; nhân viên mute/hang up được.
6. Khách nghe thông báo recording; hệ thống lưu consent.
7. Call log cập nhật đúng các mốc thời gian và kết quả.
8. Recording chỉ phát được cho user có quyền.

### Test bắt buộc

- Viettel, VinaPhone, MobiFone; Wi‑Fi và mạng doanh nghiệp.
- Busy, rejected, no-answer, invalid number, microphone denied, mất mạng, refresh tab.
- Caller ID, spam label, độ trễ, âm thanh một chiều, echo/noise.
- Webhook trùng/lệch thứ tự; idempotency.
- Một user không được nghe recording của phòng khám khác.
- Token hết hạn, số cuộc gọi đồng thời và giới hạn chi phí.

### Tiêu chí pass đề xuất

- Gọi thành công tới cả ba nhà mạng trong tập test có kiểm soát.
- Hai chiều rõ, không one-way audio; trạng thái và thời lượng khớp.
- Recording chỉ bắt đầu theo flow consent đã duyệt và truy cập đúng RBAC.
- Call log truy vết được từ nhân viên → khách → lịch hẹn → provider call ID.
- Có số liệu thực tế: tỷ lệ bắt máy/kết nối, P95 setup time, lỗi theo carrier, chi phí/phút và chi phí/cuộc.

## 7. Deliverable đúng yêu cầu sếp

1. Báo cáo ngắn 5–8 trang/slides: định nghĩa bài toán, kiến trúc, shortlist, so sánh, rủi ro, khuyến nghị.
2. PoC Stringee: browser gọi một số test +84 và tải/phát recording có phân quyền.
3. Một trang kết quả test thực tế theo carrier/network và chi phí.
4. Quyết định Go/No-Go và backlog production hóa.

Thời lượng hợp lý: 3–5 ngày làm việc cho nghiên cứu + PoC hẹp, chưa bao gồm quy trình pháp lý, mua/định danh số và production hardening.

## 8. Nguồn chính thức đã đối chiếu

- Stringee Web SDK, web-to-phone và sample WebPhone: https://developer.stringee.com/docs/getting-started-stringee-web-sdk
- Stringee Call API overview, recording, answer/event URL: https://developer.stringee.com/docs/call-api-overview
- Stringee REST API và recording download: https://developer.stringee.com/docs/call-rest-api
- Stringee pricing Call API: https://stringee.com/vi/pricing-call
- Twilio Voice JavaScript SDK: https://www.twilio.com/docs/voice/sdks/javascript
- Twilio Voice SDK call architecture: https://www.twilio.com/docs/voice/sdks
- Twilio recording with Dial: https://www.twilio.com/docs/voice/twiml/dial
- Twilio Vietnam voice guidelines: https://www.twilio.com/en-us/guidelines/vn/voice
- Twilio Video: PSTN participant is audio-only: https://www.twilio.com/docs/video/tutorials/understanding-video-recordings-and-compositions
- Telnyx WebRTC JS Call: https://developers.telnyx.com/docs/voice/webrtc/js-sdk/classes/call
- Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15: https://vanban.chinhphu.vn/?classid=1&docid=214590&pageid=27160&typegroup=

## 9. Quyết định đề xuất hiện tại

**Go với PoC Stringee cho Web-to-Phone voice 1:1 có recording.** Dùng Twilio làm benchmark kỹ thuật. Không đưa LiveKit/Jitsi vào PoC chính vì chúng không tự giải quyết việc quay số PSTN. Song song, xác nhận với sếp một câu duy nhất: khách chỉ cần nghe thoại qua số điện thoại, hay bắt buộc phải thấy hình qua một link web?

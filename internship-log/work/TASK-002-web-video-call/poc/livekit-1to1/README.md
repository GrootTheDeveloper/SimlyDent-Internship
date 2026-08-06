# LiveKit 1:1 PoC

PoC triển khai luồng video call 1:1 tự host theo quyết định của TASK-002, với **TASK-003 Phase 0** hard multi-clinic isolation. Backend ứng dụng là authority cho **clinic**, invitation, call state và quyền cấp media token; LiveKit chỉ xử lý media room.

## Thành phần

| Thành phần | Phiên bản | Trách nhiệm |
|---|---:|---|
| LiveKit Server | 1.13.1 | SFU, signaling media, WebRTC transport |
| LiveKit Egress | 1.12.0 | Ghi room thành file MP4 |
| Redis | 7.4 | Kênh điều phối giữa LiveKit Server và Egress |
| ASP.NET Core | .NET 10 | `CallSession`, clinic authorization, SignalR, LiveKit JWT |
| Vue | 2.7.16 | Caller/callee UI và điều khiển media |
| livekit-client | 2.21.0 | Kết nối room, publish/subscribe track |
| SignalR client | 10.0.11 | Invitation và authoritative state event |
| Vite | 7.3.6 | Build frontend; không phục vụ production runtime |

Không dùng LiveKit Cloud, token service bên thứ ba, managed TURN hoặc SDK .NET không chính thức.

## Giao diện thử nghiệm

- Bố cục master–detail theo mô hình ứng dụng nhắn tin: danh sách user bên trái, contact đang chọn bên phải.
- Có tìm kiếm user, trạng thái online và nút gọi tại từng dòng/header.
- Gọi đi được thực hiện từ danh sách người dùng. Phía nhận có popup chấp nhận hoặc từ chối.
- Sau khi chấp nhận, hai phía mở màn hình `/call/{callId}` riêng với video từ xa, video cục bộ và các nút điều khiển.
- Mobile web dùng bố cục một cột: danh sách liên hệ cuộn ngang, vùng gọi chiếm phần còn lại, điều khiển nằm trong thumb zone và tôn trọng safe-area của iPhone.
- Video sử dụng inline playback. Luồng video nhận được đăng ký chủ động để tránh bỏ lỡ track trên trình duyệt di động.
- Video dọc dùng tỷ lệ gốc, co theo chiều cao vùng gọi và không cắt khung hình. Nếu Safari chặn autoplay audio, giao diện hiển thị nút bật âm thanh.
- Camera được yêu cầu ở mức 720p/30fps. Bên nhận chủ động chọn lớp simulcast cao nhất; khi đường truyền giảm, trình duyệt ưu tiên giữ độ phân giải và hạ số khung hình trước.
- Nhãn `HD`, `SD` hoặc `LOW` trên màn hình gọi mở bảng số liệu gồm độ phân giải, fps, bitrate, tỷ lệ mất gói, độ trễ và nguyên nhân giới hạn chất lượng.
- Nút chấm đỏ bắt đầu/dừng ghi hình. Trạng thái **Đang ghi** được hiển thị cho cả hai bên; file MP4 được lưu trong thư mục `recordings` và có thể tải sau khi dừng ghi.

## Deploy lên VPS (máy khác mạng)

Để client ở **mạng khác nhau** gọi được (không chỉ cùng Wi‑Fi), dùng stack VPS:

- Hướng dẫn đầy đủ: [docs/vps-deploy.md](docs/vps-deploy.md)
- Compose: `docker-compose.vps.yml`
- Script Linux: `scripts/start-vps.sh`

Tóm tắt trên VPS Ubuntu:

```bash
git clone https://github.com/GrootTheDeveloper/SimlyDent-Internship.git
cd SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1
cp .env.vps.example .env
# Sửa DOMAIN, PUBLIC_IP, LIVEKIT_API_SECRET
chmod +x scripts/start-vps.sh
./scripts/start-vps.sh
```

Cần domain trỏ A-record tới VPS và mở port `80,443,7881,3478,50000-50050/udp`.  
Hai máy mở `https://DOMAIN/`, đăng nhập A1 / A2 với mật khẩu demo `Demo@123`.

## Chạy PoC (local / cùng LAN)

Yêu cầu: Docker Desktop với Linux containers.

```powershell
.\scripts\start.ps1
```

Script sinh API secret ngẫu nhiên vào `.env` ở lần chạy đầu, sau đó build và khởi động stack. `.env` bị loại khỏi source control.

LiveKit Egress dùng Chromium và bộ mã hóa video nên image lớn hơn các service còn lại. Máy chạy PoC cần tối thiểu 4 CPU và 4 GB RAM khả dụng cho một tiến trình ghi hình đồng thời.

Nếu Docker CLI trên Windows không nhận subcommand `compose`:

Script tự dùng `docker-compose.exe` tại đường dẫn Docker Desktop chuẩn nếu Docker CLI không nhận subcommand `compose`.

Mở hai tab: `http://localhost:5173/`

1. Đăng nhập **A1** và **A2** (mật khẩu demo mọi user: `Demo@123`) — API trả JWT access token, SPA lưu session và gửi `Authorization: Bearer …`.
2. Cả hai phải hiện **online** (SignalR hub sau login).
3. Chọn A2 tại tab A1 và bấm **Bắt đầu gọi**. Tab A2 nhận invitation, bấm **Chấp nhận**, cấp quyền camera/microphone, sau đó hai phía join cùng LiveKit room.

Các identity A1/A2/A3 thuộc **`clinic-a`**; B1 thuộc **`clinic-b`**. ClinicId gắn trong JWT lúc login (server-owned); client không được override bằng body/query/header. Không còn giả danh bằng header `X-User-Id`.

**LiveKit room (backend-generated):** `clinic:{clinicId}:call:{callId}`  
**SignalR groups:** `clinic:{clinicId}` và `clinic:{clinicId}:user:{userId}`

### Kiểm thử isolation (Phase 0) + routing (Phase 1)

Backend phải đang chạy (`http://localhost:5080` hoặc URL VPS):

```powershell
# Full suite (smoke + isolation + routing; routing includes ~18s ring-timeout)
.\scripts\run-test-suite.ps1 -ApiUrl "https://YOUR_DOMAIN"

# Or individually:
.\scripts\smoke-test.ps1 -ApiUrl "https://YOUR_DOMAIN"
.\scripts\clinic-isolation-test.ps1 -ApiUrl "https://YOUR_DOMAIN" -SkipSignalR
.\scripts\routing-test.ps1 -ApiUrl "https://YOUR_DOMAIN"
# Fast routing (skip ring-timeout wait ~18s):
.\scripts\routing-test.ps1 -ApiUrl "https://YOUR_DOMAIN" -SkipSlow
```

**Phase 1 demo:** login staff **A1/A2** (Available qua SignalR). Login visitor **VA** → **Bắt đầu gọi (queue)** → backend gán longest-idle staff → Accept.  
Env: `RING_TIMEOUT_SECONDS` (15), `VISITOR_TIMEOUT_SECONDS` (120), `AGENT_HEARTBEAT_STALE_SECONDS` (45).

**Phase 2 plan:** [docs/PHASE-2-plan.md](docs/PHASE-2-plan.md).

Nếu browser không hiện prompt, mở biểu tượng quyền site cạnh thanh địa chỉ, đặt Camera và Microphone thành **Allow**, sau đó reload cả hai tab. UI hiển thị **Đang xin quyền camera và microphone…** trong khi chờ browser trả kết quả và có nút **Thử lại** khi quyền bị từ chối.

Chi tiết backlog TASK-003: [docs/TASK-003-multi-clinic-backlog.md](docs/TASK-003-multi-clinic-backlog.md).

Các endpoint cục bộ:

| URL/port | Chức năng |
|---|---|
| `http://localhost:5173` | Web UI |
| `http://localhost:5080` | .NET API và SignalR hub |
| `ws://localhost:7880` | LiveKit signaling |
| `localhost:7881/tcp` | WebRTC TCP fallback |
| `localhost:50000-50020/udp` | WebRTC UDP media range |

## Chất lượng video

Cấu hình hiện tại đặt mục tiêu 720p/30fps với bitrate video tối đa 2,5 Mbps. Simulcast vẫn được bật để cuộc gọi không bị ngắt khi mạng yếu, nhưng phía nhận luôn yêu cầu lớp HD. `dynacast` dừng các lớp không có người đăng ký để giảm xử lý không cần thiết.

Chất lượng thực tế vẫn phụ thuộc camera, CPU và đường truyền của cả hai thiết bị. Khi hình mờ, mở nhãn chất lượng trên màn hình gọi và đọc theo thứ tự:

1. **Nhận** dưới `1280×720` hoặc `720×1280`: phía nhận đang không có lớp HD.
2. **Tốc độ nhận** thấp hơn khoảng 800 kbps: đường truyền thiếu băng thông hoặc có nghẽn.
3. **Mất gói** trên 2% hoặc độ trễ tăng cao: mạng không ổn định; tăng bitrate không giải quyết được.
4. **Giới hạn = bandwidth/cpu**: trình duyệt đang tự giảm chất lượng do mạng hoặc khả năng xử lý của thiết bị.

Không khóa bitrate tối thiểu ở mức cao vì cách này làm cuộc gọi dễ đứng hình trên mạng yếu. Mục tiêu 720p là cấu hình ưu tiên, không phải cam kết rằng mọi mạng đều giữ được HD.

## Ghi hình

Ghi hình được thực hiện ở phía máy chủ bằng LiveKit Egress, không phụ thuộc tab trình duyệt của người dùng. Quy trình:

1. Trong cuộc gọi đã kết nối, bấm nút chấm đỏ và xác nhận.
2. Cả hai bên nhìn thấy trạng thái **Đang ghi**.
3. Bấm lại nút chấm đỏ để dừng. Chờ Egress hoàn tất file rồi bấm nút tải xuống.
4. File gốc được lưu tại `recordings/call-<id>-<timestamp>.mp4` trên host.

API chỉ cho hai người thuộc đúng cuộc gọi bắt đầu, dừng hoặc tải file. Bản production phải bổ sung chính sách đồng ý ghi hình, thời hạn lưu, mã hóa ổ đĩa, audit log và quyền tải theo quy định dữ liệu của doanh nghiệp.

## Chia sẻ bằng một liên kết HTTPS

Để người kiểm thử mở ứng dụng trực tiếp mà không phải cài chứng thư, chạy:

```powershell
.\scripts\start-share.ps1
```

Script build và khởi động PoC, tạo Cloudflare Quick Tunnel, sau đó in ra `PUBLIC TEST URL`. Gửi nguyên liên kết `https://...trycloudflare.com` cho người kiểm thử. Trình duyệt chỉ yêu cầu quyền camera/microphone khi bắt đầu cuộc gọi.

Quick Tunnel chỉ dùng để demo: URL thay đổi khi container `cloudflared` được tạo lại, không có cam kết ổn định và lưu lượng HTTPS/WebSocket đi qua hạ tầng Cloudflare. LiveKit, backend, media room và dữ liệu ứng dụng vẫn chạy trên máy host. Hai thiết bị nên ở cùng Wi-Fi vì media WebRTC trong cấu hình PoC vẫn kết nối trực tiếp tới LiveKit tại IP LAN; triển khai qua Internet cần hostname cố định, public ingress và TURN.

Trình duyệt mobile khuyến nghị: Chrome trên Android và Safari trên iOS. Mở link ở tab trình duyệt chính, không mở trong webview của ứng dụng nhắn tin; cấp Camera và Microphone khi nhận hoặc bắt đầu cuộc gọi.

Trên máy host, mở PowerShell bằng quyền **Administrator** một lần để cho phép media WebRTC qua Windows Firewall:

```powershell
.\scripts\enable-lan-firewall.ps1
```

## Kiểm thử HTTPS nội bộ dự phòng

Chạy stack bằng script khởi động để tự nhận IPv4 của máy host và cấu hình LiveKit quảng bá địa chỉ này:

```powershell
.\scripts\start.ps1
```

Lấy địa chỉ `LAN_IP` do `start.ps1` in ra. Khi dùng Windows Mobile Hotspot, địa chỉ thường là `192.168.137.1`. Máy test cùng mạng thực hiện theo thứ tự:

1. Tải CA tại `http://<LAN_IP>:8088/root.crt`.
2. Cài CA vào kho **Trusted Root Certification Authorities** của thiết bị hoặc trình duyệt.
3. Đóng và mở lại trình duyệt, sau đó truy cập `https://<LAN_IP>:8443`.
4. Hai thiết bị đăng nhập bằng hai user cùng nhóm, ví dụ Nguyễn Minh Anh và Trần Thu Hà, rồi thực hiện gọi–nhận và cấp quyền camera/microphone.

Không dùng `http://<LAN_IP>` để test media: trình duyệt không coi private IP qua HTTP là secure context và có thể không cấp camera/microphone. Nếu IP Wi-Fi thay đổi, chạy lại `start.ps1`, tải và cài lại CA nếu chứng thư được phát hành lại. Một số router bật AP/client isolation sẽ chặn thiết bị Wi-Fi truy cập lẫn nhau; khi đó cần tắt tùy chọn này hoặc đổi mạng test.

CA nội bộ và cổng tải CA không dùng cho production. Môi trường production phải dùng hostname và chứng thư TLS được thiết bị tin cậy sẵn.

## Kiểm thử tự động

```powershell
.\scripts\smoke-test.ps1
```

Smoke test đăng nhập JWT (`Demo@123`) rồi kiểm tra:

- gọi API không Bearer / chỉ `X-User-Id` bị từ chối (401);
- A1 không thể tạo call tới B1 khác tenant;
- B1 không thể đọc metadata call của tenant A;
- token không được cấp khi call còn `Ringing`;
- callee có thể reconcile active call sau refresh;
- chỉ accept đầu tiên thắng;
- JWT chỉ có room/identity grant tương ứng call đã accept;
- recording bị từ chối khi cuộc gọi chưa được chấp nhận hoặc người gọi khác tenant;
- terminal transition lặp lại bị từ chối;
- user đang trong call không nhận call thứ hai.

Kiểm thử ghi hình end-to-end dùng LiveKit CLI phát video mẫu 720p, sau đó xác nhận MP4 và quyền tải:

```powershell
.\scripts\recording-e2e-test.ps1
```

Script cần `lk` trong `PATH` hoặc truyền đường dẫn bằng `-LiveKitCli`. Bài test không dùng camera/microphone thật.

### Load / capacity (tự động)

```powershell
.\scripts\run-capacity-suite.ps1
```

Đo **API concurrent pairs** (JWT create/accept/token/end) và **media rooms** (LiveKit CLI + Prometheus Mbps/loss). Báo cáo: `evidence/capacity-runs/suite-*/SUMMARY.md`.

```powershell
# Lặp 4 lần để lấy p50/avg (không kết luận từ 1 run)
.\scripts\run-repeated-media-load.ps1 -Repetitions 4 -ConcurrentRooms "1,3,5"
```

- Capacity auto: [docs/capacity-load-testing.md](docs/capacity-load-testing.md)  
- **Test browser thật × 3–4 lần:** [docs/real-world-test-protocol.md](docs/real-world-test-protocol.md)  
- **Báo cáo gửi sếp (PDF):** [TASK-002-PoC-Video-Call-Ket-Qua.pdf](TASK-002-PoC-Video-Call-Ket-Qua.pdf) · nguồn LaTeX `docs/latex/`  
- **Markdown ngắn:** [REPORT-GUI-SEP.md](REPORT-GUI-SEP.md)  
- **Markdown tổng hợp:** [REPORT-TONG-HOP-SEP.md](REPORT-TONG-HOP-SEP.md)  
- **TASK-003 backlog (multi-clinic, siết product/invariant/AC):** [docs/TASK-003-multi-clinic-backlog.md](docs/TASK-003-multi-clinic-backlog.md)  
- **Handoff prompt:** [docs/PROMPTS/project-handoff.md](docs/PROMPTS/project-handoff.md)

Trong cuộc gọi thật, mở badge chất lượng → **Tải báo cáo CSV** hoặc **Kết thúc + tải**. Xuất lại từ API:

```powershell
.\scripts\export-quality.ps1 -CallId "<uuid>" -UserId A1
.\scripts\aggregate-quality-exports.ps1 -InputDir .\evidence\perf-real\exports
```

## Quy tắc state và token

```text
Ringing -> Accepted -> Ended
Ringing -> Rejected
Ringing -> Cancelled
```

Mọi transition được kiểm tra trong critical section của từng `CallSession`. JWT dùng HS256, TTL 5 phút, `sub = tenant:user`, chỉ cho join đúng `call-{uuid}` và chỉ phát sau `Accepted`. Secret chỉ nằm ở backend và LiveKit config; frontend không chứa API secret.

## Dừng và xóa container

```powershell
docker compose down
```

Lệnh này xóa container/network của PoC; source và image build cache vẫn được giữ.

## Giới hạn đã biết

- Auth PoC đã là **JWT access token** (login + `PasswordHasher`, claims user/tenant). Vẫn còn khoảng production: refresh token HttpOnly, rotate `JWT_SECRET`, rate limit, IdP/SSO thật.
- State lưu trong memory; restart backend làm mất call. Production cần PostgreSQL và optimistic/atomic transition.
- Cấu hình là single-node; HTTPS qua LAN dùng CA nội bộ và Quick Tunnel chỉ phục vụ demo. Chưa có TLS/domain production, external IP discovery, TURN hay forced-relay evidence.
- LiveKit quảng bá IP LAN cho media; thiết bị khác mạng có thể mở UI qua tunnel nhưng không được coi là media-qualified.
- Chưa xử lý no-answer timer, webhook participant reconciliation, multi-node presence và rate limiting.
- Browser media cần kiểm thử thủ công trên hai thiết bị/network; smoke test không tự cấp quyền camera/microphone.
- Laptop và iPhone đã kết nối cùng phòng và phát media trong mạng Mobile Hotspot; laptop đã nhận video từ iPhone. A/V hai chiều sau bản sửa cần một lần nghiệm thu cuối.
- Vue 2 đã EOL. `npm audit` ngày 2026-08-05 còn một advisory mức thấp ở Vue 2; bản sửa yêu cầu nâng major lên Vue 3.
- Ghi hình hiện lưu MP4 trên ổ đĩa host, chưa có object storage, retention job, mã hóa riêng hoặc cơ chế xin chấp thuận của người còn lại. Kế hoạch phát triển: [docs/recording-storage-development-plan.md](docs/recording-storage-development-plan.md).
- Kế hoạch đo hiệu năng cuộc gọi kéo dài (~5 phút) và metric: [docs/performance-test-plan.md](docs/performance-test-plan.md).
- Inventory nợ kỹ thuật còn lại: [evidence/2026-08-06-residual-debt-inventory.md](evidence/2026-08-06-residual-debt-inventory.md).

Kết quả lần chạy hiện tại nằm tại [evidence/2026-08-05-local-run.md](evidence/2026-08-05-local-run.md).

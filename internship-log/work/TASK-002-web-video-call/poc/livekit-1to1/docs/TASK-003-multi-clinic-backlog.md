# TASK-003 — Multi-clinic call platform (backlog siết)

**Trạng thái:** Decisions **chốt** (mục 2) — sẵn sàng implement theo thứ tự mục 7  
**Baseline:** TASK-002 LiveKit 1:1 PoC (`poc/livekit-1to1/`)  
**Repo:** SimlyDent-Internship · `main`  
**Cách đọc doc này:** mỗi hạng mục tách **Product requirement** · **Technical invariant** · **Acceptance criteria (AC)**. Không trộn ba lớp trong cùng một câu DoD mơ hồ.

### MVP success (một câu)

> Chứng minh: **Visitor clinic A → queue A → đúng staff A → call 1:1 → optional recording → lưu đúng clinic A**, và **clinic B không truy cập được resource nào của A**.  
> **Không** phải build full call-center platform.

---

## 0. Bốn invariant kiến trúc (không được phá)

Mọi design/PR sau này hỏi: *có phá invariant nào không?*

| # | Phase | Invariant |
|---|--------|-----------|
| I0 | Isolation | **Một clinic không bao giờ** đọc/ghi/subscribe call, media, recording, presence, queue của clinic khác. |
| I1 | Routing | **Auto-dispatch:** một call ≤ 1 assigned staff; một staff ≤ 1 Ringing/InCall; chọn agent bằng longest-idle/RR trên backend. |
| I2 | Embed | **API ≠ Widget.** Widget chỉ là client của Public Embed API. Browser **chỉ** nhận credential short-lived, scoped clinic; website clinic **không** biết routing/LiveKit secret/**không** tự chọn room. |
| I3 | Recording | Lỗi recording / post-process / storage **không** được terminate hoặc phá control path của live call. |

---

## 1. Bối cảnh & mục tiêu sản phẩm

### Product goal
Một hạ tầng cung cấp **video/audio call tư vấn** cho **nhiều phòng khám**. Mỗi clinic có landing/widget riêng; khách gọi đúng clinic; staff rảnh nhận call; có tùy chọn lưu cuộc gọi mà không làm sập live path.

### Baseline đã có (TASK-002)
- Call 1:1, JWT, tenant isolation cơ bản, SignalR invite, LiveKit SFU, Egress MP4 (VPS 2 vCPU đã hạ `cpu_cost`).
- Capacity + real-call evidence trên VPS/local.

### Ngoài scope MVP (ghi rõ)
- Group call, transfer, supervisor listen/barge  
- Staff claim / hunt-group  
- Full custom CSS / branding engine  
- App mobile native, AI transcript, booking/CRM  
- Default Video recording  
- Hardcode retention 7/30/90 trong domain logic (chỉ default config)  
- Gắn recording scale vào 1 VPS 2 vCPU  
- Compliance platform đầy đủ (chỉ **hooks**: policy, consent, audit, ACL)

---

## 2. Quyết định đã chốt (team — triển khai thống nhất)

| # | Chủ đề | Quyết định |
|---|--------|------------|
| **1 Recording mode** | Chọn **trước hoặc trong call**: `None` / `AudioOnly` / `Video`. **Không** record-all rồi end mới keep/delete (vẫn tốn full CPU/disk/BW). Sau khi đã record: end call chỉ **retention** (giữ / xóa / TTL policy clinic). **Default ban đầu:** `None` hoặc `AudioOnly` — **không** default Video nếu chưa có BR rõ. |
| **2 “50 concurrent”** | = mục tiêu ~**50 cuộc gọi đồng thời** (media/signaling). **Recording workload tách riêng**, không mặc định 50 video record. Benchmark: **R1** 50 call + video record nhẹ 480p/15; **R2** 50 audio-only record; **R3** mix sau khi có R1/R2. **Không** suy capacity recording từ load media hiện tại. 50 video record không fit 1 node → **scale recording worker/egress riêng**; không yêu cầu 2 vCPU làm hết. |
| **3 Recording access** | Visitor: **không** xem/tải. Staff tham gia call: thấy **metadata**, **không** default tải. **Manager/Admin đúng clinic**: xem/tải/xóa. Mọi thao tác authorize `clinic_id`. **Audit log tối thiểu:** create / download / delete. **Consent** có chỗ trong model/API từ đầu (MVP policy đơn giản OK). |
| **4 Ngoài giờ / no staff** | **Không** chờ vô hạn. **Trong giờ:** queue → dispatch Available → ring ~15s → next staff → nếu không rảnh thì queue tới `visitor_timeout` → `NoAgent`/`Timeout`. **Ngoài giờ:** **không** vào queue → ngay `Closed` + UI “phòng khám ngoài giờ”. Working hours + timeout **config theo clinic**, MVP có default chung. |
| **5 Routing** | Backend **auto-dispatch**. Ưu tiên **longest-idle** trên `Available`; RR = fallback / impl đơn giản. Invariant: 1 call ≤ 1 assignee; 1 staff ≤ 1 Ringing/InCall; timeout/reject/disconnect **release**; end → Available nếu connection hợp lệ. **Không** claim/hunt-group MVP. |
| **6 Presence** | `Offline` / `Available` / `Ringing` / `InCall`. Heartbeat/**lease** bắt buộc; stale → Offline + release. `Away`/`Pause` **sau**. |
| **7 Embed** | `site_key` public: resolve clinic + visitor session/call. Không secret. Backend: domain allowlist + rate limit + short-lived visitor session + clinic scope server-side. Staff auth riêng. LiveKit secret **không** xuống browser. |
| **8 Widget scope MVP** | **Visitor:** floating button; Waiting/Ringing/Connected/Ended; controls AV cơ bản. **Staff:** portal/console **riêng trước**; queue, agent state, assigned incoming; Accept/Reject/End. Branding: logo, tên clinic, vài màu — **chưa** full custom CSS. |
| **9 Media scope** | **1 visitor ↔ 1 staff** only. Cam/mic: xin quyền **khi chuẩn bị vào media**, **không** xin lúc landing load. |
| **10 Storage** | Disk VPS = PoC/dev only. Phase recording scale → **object storage interface** (S3-compatible; MinIO/S3). App **không** lock vendor. Fail record/storage/post-process **không** fail live call. |
| **11 Retention** | `RecordingPolicy` per clinic: mode, `retentionDays`, access policy. Không hardcode ngày trong domain. MVP default config **30 ngày** để test lifecycle, **configurable**. |
| **12 Thứ tự implement** | isolation → presence+agent state → routing/queue → visitor API → staff API/console → embed widget → recording policy → object storage + async → recording capacity test. **Không** recording scale / widget phức tạp trước isolation+routing. |

---

## 3. Phase 0 — Clinic isolation

### Product requirement
Nhiều clinic dùng chung server; cuộc gọi / staff / recording / realtime event của clinic A **không** rơi vào clinic B.

### Technical invariant (I0 mở rộng)
`clinic_id` **không** chỉ là column trên entity. **Mọi thao tác đọc/ghi resource authorize theo clinic ở server-side.**

Không tin `clinic_id` (hay callId “guess”) từ browser làm nguồn truth. Clinic derive từ:

- **Staff:** JWT/session principal → `clinic_id` + role  
- **Visitor:** public `site_key` → resolve clinic (server map) + domain check  

Ánh xạ bắt buộc:

| Resource | Binding |
|----------|---------|
| SignalR group | `clinic:{clinicId}` |
| LiveKit room | `clinic:{clinicId}:call:{callId}` |
| Media token claims | exact room + identity (+ TTL) |
| Queue key | `clinic:{clinicId}` |
| Recording object path | `clinic/{clinicId}/yyyy/mm/...` |
| API query | clinic từ principal / site key, **không** từ body tùy ý |

### Acceptance criteria
- [ ] Clinic B **không** đọc metadata call clinic A  
- [ ] Clinic B **không** accept / end call A  
- [ ] Clinic B **không** lấy LiveKit token của call A  
- [ ] Clinic B **không** tải recording A  
- [ ] Clinic B **không** subscribe / nhận SignalR event của clinic A  
- [ ] Visitor/staff **không** cross-clinic dù biết `callId` / `userId`  
- [ ] Suite test isolation tự động (mở rộng pattern tenant A1–B1 của PoC)

---

## 4. Phase 1 — Routing, agent state, queue

### Product requirement
Khách vào landing clinic X → bấm gọi → chỉ staff clinic X; ưu tiên người **có thể nhận**; sau end call staff sẵn sàng call mới. Hết người rảnh / timeout có trạng thái rõ cho UX.

### Technical invariant (I1)
- Staff state là **lease**, không phải boolean online.  
- **1 call → tối đa 1 assigned staff** (đang Ringing hoặc InCall).  
- **1 staff → tối đa 1 Ringing/InCall**.  
- Reserve/assign/release **atomic** trên server (critical section / CAS / transaction).  
- Chọn agent **chỉ trên backend** — không round-robin index ở frontend.

### 4.1 Agent state machine (tối thiểu 4 trạng thái)

```text
Offline ──heartbeat/login──► Available
Available ──dispatcher reserve──► Ringing   // reservedCallId set; không còn “Available”
Ringing ──accept──► InCall
Ringing ──reject / ring-timeout (~15s) / offline──► Available | Offline
                                                 └── release reservation → try next staff | re-queue
InCall ──end──► Available ──► dispatcher lấy queue head (nếu có)
* ──stale heartbeat──► Offline (+ release + redispatch)
```

Optional sau: `Away` / `Paused`.

**Vì sao cần `Ringing`:** Call X gán A → A = Ringing; Call Y tới ngay sau → dispatcher **không** thấy A Available → chọn B. Tránh 1 staff bị gán 2 call.

Lease fields (khái niệm):

```text
state                 // Offline | Available | Ringing | InCall
connectionId
heartbeatAt
reservedCallId?       // set khi Ringing / InCall
lastAssignedAt?       // để longest-idle / fair round-robin
```

### 4.2 Semantics routing — **MVP: auto-dispatch (ACD mini)** (D1 Resolved)

**Không dùng hunt-group claim cho MVP** (nhiều visitor cùng lúc → list incoming hỗn loạn, staff “tranh” call).

#### Quyết định MVP

> Backend **auto-dispatch** theo **round-robin / longest-idle** trên tập staff `Available`.  
> **Một call chỉ ring đúng một staff** tại một thời điểm.  
> Accept trong ~15s → InCall.  
> Timeout / Reject / offline → release, staff về Available (nếu online), thử **staff kế** (không lặp lại ngay cùng người nếu còn ứng viên khác — policy chi tiết implement).  
> Hết danh sách Available (hoặc không còn ai rảnh) → call **Queued** (không mất call) cho tới khi có agent Available hoặc visitor **Timeout**.  
> Thử hết + hết chờ → `NoAgent` / `Timeout`.

#### Luồng một visitor

```text
Visitor gọi
   ↓
Call → queue clinic (FIFO)
   ↓
Backend: staff Available?
   ├─ không → giữ Queued (chờ agent free hoặc visitor timeout)
   └─ có → chọn Staff A (longest-idle / RR cursor)
          ↓
       A = Ringing, call = Ringing (chỉ A nhận Accept UI)
          ↓  ~15s
       ├─ Accept → A = InCall, call = Accepted → cấp media token
       └─ Timeout / Reject
              ↓
           A = Available (nếu vẫn online)
              ↓
           chọn Staff B (Available) → Ringing 15s
              …
           không còn ai → Queued lại (chờ) hoặc NoAgent/Timeout
```

#### Nhiều visitor song song (ví dụ)

```text
Staff: A,B,C Available
Visitor V1..V5 vào gần nhau

Dispatch:
  V1 → A (Ringing)
  V2 → B
  V3 → C
  V4, V5 → Queue (Waiting)

B end call → B = Available → dispatcher ngay: V4 → B
A timeout V1, lúc đó không ai rảnh → V1 trở lại Queue (không mất)
```

#### Staff console UX

- **Tất cả staff** (cùng clinic) có thể thấy overview: Agents + Queue (waiting times).  
- **Chỉ staff đang được assign** thấy popup/nút **Accept/Reject** của call đó.  
- Không broadcast “mọi người Accept cùng lúc”.

#### Thuật toán chọn staff (backend)

1. **Preferred (dễ scale + công bằng):**  
   `Available staff ORDER BY last_assigned_at ASC NULLS FIRST LIMIT 1`  
   → người **lâu nhất chưa được assign** (longest-idle).  
2. **Tương đương RR:** cursor/`lastAssignedAt` cập nhật mỗi lần reserve thành công.  
3. **Không** giữ index round-robin trên frontend.

| Mode (tham chiếu) | MVP? | Ghi chú |
|-------------------|------|---------|
| **Auto dispatch + longest-idle/RR** | **Có** | ACD mini; UI sạch |
| Hunt-group claim | Không (MVP) | Có thể phase sau nếu clinic muốn “ai rảnh bấm trước” |

### 4.3 Queue rules (MVP — chốt cứng)

| Rule | MVP default |
|------|-------------|
| Order | **FIFO** |
| Staff capacity | **1** (Ringing hoặc InCall) |
| Agent ringing timeout | configurable (**~15s**) |
| Visitor max wait (`visitor_timeout`) | configurable (default chung MVP) — **không chờ vô hạn** |
| Outside working hours | **không** enqueue → status **`Closed`** + message ngoài giờ |
| Working hours | config **per clinic**, MVP default chung |
| Reject / ring timeout | release → next Available; không còn → **re-queue** tới visitor_timeout |
| Agent offline while Ringing | release + redispatch / re-queue |
| Visitor cancel | remove queue, cancel ringing assignment |
| Một visitor mở 2 call | **không** (1 active visitor session) |
| End call | agent → Available (nếu connection hợp lệ) → **ngay** dispatch queue head |
| Trong giờ, tạm không staff rảnh | **Queued** tới có Available hoặc `visitor_timeout` → `NoAgent`/`Timeout` |

Call / queue states: `Closed` · `Queued` · `Ringing` · `Accepted`/`InCall` · `NoAgent` · `Timeout` · `Ended` · `Cancelled`.

### Acceptance criteria
- [ ] Tại mọi thời điểm: 1 call ≤ 1 assigned staff; 1 staff ≤ 1 Ringing/InCall  
- [ ] Chỉ staff được assign nhận event Accept UI; staff khác **không** Accept được call đó (403)  
- [ ] Staff Ringing không bị gán call thứ hai  
- [ ] Timeout/Reject 15s → staff free (nếu online) + call chuyển staff khác hoặc Queued  
- [ ] N Available staff + N+k visitor → tối đa N call Ringing/InCall; phần dư Queued  
- [ ] End call → queue head được dispatch trong SLA ngắn (vd. ≤ 2s path server)  
- [ ] Heartbeat stale → Offline, nhả reservation, call redispatch/re-queue  
- [ ] Longest-idle (ưu tiên) / RR fallback do **backend** (`lastAssignedAt`); không phụ thuộc client  
- [ ] Visitor cancel / visitor_timeout không để staff kẹt Ringing  
- [ ] Ngoài giờ → `Closed`, **không** có row queue  
- [ ] Hết visitor_timeout trong giờ → `NoAgent`/`Timeout`, không chờ vô hạn  

---

## 5. Phase 2 — Public Embed API + Widget (tách rõ 2 thứ)

> **Wording sếp “nhúng API”** dễ hiểu nhầm. Thực tế có **hai thứ khác nhau**:
>
> | | **API** | **Widget** |
> |--|---------|------------|
> | Là gì | Backend endpoints website/clinic client gọi | UI nhỏ nhúng vào website (nút góc phải, mini call) |
> | Ai host | SimlyDent (`call.simlydent.vn`…) | Script/iframe SimlyDent trên domain clinic |
> | Quan hệ | Source of truth cho session/queue/token | **Client của API** — không tự routing, không tự LiveKit |
>
> Diễn đạt product dễ hiểu hơn:
>
> > SimlyDent cung cấp **widget** để mỗi phòng khám chèn vào website. Widget gọi **Public Embed API** để tạo yêu cầu tư vấn; backend xác định clinic từ `site_key`, điều phối staff và **chỉ cấp quyền media sau khi cuộc gọi được nhận**. Website clinic **không** cần biết routing staff, LiveKit secret, hay room name.

### Product requirement
- **Visitor widget MVP:** floating call button; states Waiting / Ringing / Connected / Ended; AV controls cơ bản; **không** full custom CSS (logo + tên + vài màu).  
- **Staff MVP:** portal/console **riêng** (trước khi polish widget staff); queue, agent state, incoming **assigned** call; Accept / Reject / End.  
- Clinic chèn snippet; SimlyDent: site_key → clinic → session → queue → auto-dispatch → Accept → media → optional record → end.  
- Media: **1:1 only**; getUserMedia **chỉ khi** chuẩn bị join media (không lúc landing load).

### Technical invariant (I2)
- Website clinic **không** biết routing, **không** có LiveKit secret, **không** tự chọn room.  
- Widget **không** `connect LiveKit` ngay khi bấm gọi — chỉ gọi API; media credential **sau** Accepted.  
- `site_key` trong browser = **public identifier** (hạn chế quyền), **không** phải secret auth.  
- Staff **không** dùng `site_key`; dùng JWT → `clinic_id` từ principal.

### 5.1 Luồng visitor (chuẩn)

```text
Khách trên https://phongkham-a.vn
        │ bấm "Gọi tư vấn"
        ▼
SimlyDent Widget (script / iframe)
        │ POST /embed/calls  { siteKey: "pk_clinic_a" }
        ▼
SimlyDent Backend
        ├─ site_key → Clinic A
        ├─ kiểm tra domain allowlist (Origin/Referer + policy)
        ├─ rate limit (IP / session / clinic queue)
        ├─ tạo visitor session + call → queue clinic A
        └─ staff clinic A (SignalR group clinic:A)
                │ Accept (Staff API + JWT)
                ▼
         Backend cấp LiveKit JWT short-lived (room đúng clinic)
                ▼
             LiveKit SFU (media only)
```

### 5.2 Public Embed API (visitor) — skeleton

Quyền của `site_key` **rất hẹp**:

```text
create visitor session
create consultation / call request
read status của chính session/call đó
cancel chính call đó
```

**Không** cho: list staff, list call clinic, download recording, end call của người khác, mint token tùy ý.

Ví dụ surface (tên có thể chỉnh khi implement):

```http
POST /embed/session
POST /embed/calls
GET  /embed/calls/{callId}
POST /embed/calls/{callId}/cancel
```

Request gợi ý:

```json
POST /embed/calls
{ "siteKey": "pk_clinic_a" }
```

Response sớm:

```json
{ "callId": "call_123", "status": "queued" }
```

Sau accept (poll / realtime channel scoped session):

```json
{ "callId": "call_123", "status": "accepted", "media": { /* short-lived LiveKit join */ } }
```

### 5.3 Staff API (khác hẳn visitor)

```text
Staff → login → JWT → clinic_id từ JWT → Staff REST + SignalR
```

Ví dụ:

```http
GET  /staff/queue
GET  /staff/agents
POST /staff/calls/{id}/accept
POST /staff/calls/{id}/reject
POST /staff/calls/{id}/end
```

Panel gợi ý (góc trái / drawer):

```text
Clinic A
Staff: Lan Available | Minh InCall | Hùng Ringing
Queue: Visitor #101 00:12 | #102 00:05
```

### 5.4 `site_key` + multi-clinic

Cùng host SimlyDent phục vụ nhiều clinic:

```text
call.simlydent.vn
  pk_a → clinic-a
  pk_b → clinic-b
  pk_c → clinic-c
```

Ai mở DevTools cũng thấy `site_key` → **không** gán quyền “toàn bộ clinic”.

### 5.5 Domain allowlist + rate limit (không phải auth tuyệt đối)

| Clinic | site_key | allowed_domains (ví dụ) |
|--------|----------|-------------------------|
| A | `pk_a` | `phongkham-a.vn`, `www.phongkham-a.vn` |

Copy script sang `spam-site.com` → backend **từ chối** (theo Origin/Referer + server policy).

Allowlist **giảm abuse**, không đủ một mình → thêm rate limit MVP:

| Scope | Gợi ý |
|-------|--------|
| IP | max N call requests / phút (vd. 5) |
| Visitor session | max **1** active call |
| Clinic | configurable queue depth / concurrent visitor calls |

### 5.6 Cách nhúng widget (2 kiểu)

| Kiểu | Clinic làm gì | Ưu | Nhược |
|------|---------------|-----|--------|
| **Script DOM** | `<script src="…/widget.js" data-site-key="…">` tự vẽ button/modal | Custom UX dễ | CSS/JS host dễ “đụng” widget |
| **iframe** | `<iframe src="…/embed?site=pk_a">` hoặc script **tạo iframe** | Isolation CSS/cam-mic/version/security boundary tốt hơn | UX/resize/postMessage phức tạp hơn |

**Đề xuất PoC/internship:** **iframe**, hoặc `embed.js` chỉ bootstrap iframe SimlyDent:

```text
clinic website
  └── embed.js
        └── iframe https://call.simlydent.vn/embed?...
              └── UI + gọi Public Embed API
```

Snippet mục tiêu cho clinic:

```html
<script
  src="https://call.simlydent.vn/embed.js"
  data-site-key="pk_clinic_a">
</script>
```

### 5.7 Deliverables (thứ tự chốt)

1. Routing + isolation ổn  
2. **Visitor API** (`/embed/*`)  
3. **Staff API + console/portal** (Accept chỉ assignee)  
4. **Visitor embed widget** (iframe/script)  
5. Branding nhẹ: logo, tên, màu; working hours message  

**Không** widget phức tạp trước isolation + routing.

### Acceptance criteria
- [ ] Snippet + `site_key` → call đúng clinic  
- [ ] Bấm gọi: `/embed/*` trước; LiveKit chỉ sau Accepted; **không** lộ LiveKit secret  
- [ ] Domain ngoài allowlist bị từ chối; rate limit smoke  
- [ ] Staff JWT: queue/accept chỉ clinic mình; B không thấy A  
- [ ] Visitor: Waiting/Ringing/Connected/Ended; cam/mic không prompt lúc landing load  
- [ ] Ngoài giờ widget nhận `Closed` + message  
- [ ] (MVP) iframe hoặc script→iframe trên trang demo  

---

---

## 6. Phase 3 — Recording & storage

### Product requirement
Có tùy chọn liên quan lưu cuộc gọi; hệ thống chịu được nhiều call đồng thời **theo workload đã định nghĩa**; dung lượng kiểm soát được; không cần xem lại ngay.

### Technical invariant (I3)
- Capture media **phải** diễn ra **trong lúc call** (không “queue capture sau khi end”).  
- **Async** chỉ áp cho: upload finalization, transcode, audio extract, thumbnail, integrity, metadata, retention, archive/delete.  
- Recording/post-process/storage fail **không** drop live call.

### 6.1 Recording mode vs retention (**chốt**)

| Khái niệm | Khi nào | Giá trị |
|-----------|---------|---------|
| **Recording mode** | **Trước / trong call** | `None` · `AudioOnly` · `Video` — chỉ start pipeline cần thiết |
| **Retention** | **Sau** khi đã record | Giữ · xóa · TTL theo `RecordingPolicy` |

**Cấm MVP:** record mọi call rồi cuối mới quyết định keep (vẫn full cost).  
**Default ban đầu:** `None` hoặc `AudioOnly` — **không** default `Video`.

### 6.2 Access control recording (**chốt**)

| Actor | Quyền MVP |
|-------|-----------|
| Visitor | **Không** xem / tải |
| Staff tham gia call | Metadata OK; **không** default download |
| Manager/Admin **đúng clinic** | Xem / tải / xóa |
| Cross-clinic | **Luôn deny** |

- Mọi API recording authorize theo `clinic_id`.  
- Audit tối thiểu: **create / download / delete**.  
- **Consent** field/API trong model từ đầu (MVP policy đơn giản).

### 6.3 Storage & pipeline

- Disk VPS = **PoC/dev only**.  
- Scale phase: **object storage interface** (S3-compatible; MinIO hoặc S3) — app không lock vendor.  
- Baseline: LiveKit Egress / recording workers → object storage → async post-process.  
- Chunk client 15s = **không** product requirement (chỉ ADR nếu benchmark cần).  
- **I3:** record/storage/post-process fail **không** fail live call.

### 6.4 `RecordingPolicy` (per clinic)

```text
mode (default None | AudioOnly)
retentionDays   // configurable; MVP default config 30 for lifecycle test — NOT hardcoded in domain
access policy
(+ consent policy hooks)
```

### 6.5 Workload “50 concurrent” (**chốt**)

| Ý nghĩa | Chi tiết |
|---------|----------|
| **50 concurrent calls** | Mục tiêu hệ thống ~50 call đồng thời (media/signaling) |
| **Recording** | Workload **riêng**; không = 50 video record mặc định |

| Scenario | Workload |
|----------|----------|
| **R1** | 50 concurrent **calls** + video recording profile nhẹ **480p/15fps** |
| **R2** | 50 concurrent **audio-only** recording |
| **R3** | Mix thực tế **sau** khi có số R1/R2 |

- **Không** suy recording capacity từ media load test hiện tại.  
- 50 video record không fit 1 node → **scale egress/worker riêng**; không bắt 2 vCPU VPS.  
- Đo: CPU, RAM, net, disk, upload, start latency, fail rate, backlog, finalization latency.

### Acceptance criteria
- [ ] Mode `None` không start egress; AudioOnly/Video start đúng loại  
- [ ] Default mode ≠ Video (trừ khi config clinic đổi)  
- [ ] Visitor download → deny; staff download default → deny; admin clinic → allow + audit  
- [ ] Cross-clinic recording path → deny  
- [ ] Consent có trong model/API (dù policy đơn giản)  
- [ ] Kill egress giữa call → call vẫn sống  
- [ ] Storage qua abstraction S3-compatible (khi vào phase scale)  
- [ ] R1/R2 report riêng; R3 sau  
- [ ] Retention job dùng `retentionDays` từ policy, không magic number trong code domain

---

## 7. Thứ tự triển khai (**chốt** — không đảo)

```text
1. clinic isolation
2. presence + agent state (lease/heartbeat)
3. routing + queue (auto-dispatch, hours, timeouts)
4. visitor API
5. staff API / console
6. embed widget (visitor)
7. recording policy (+ consent hooks, access ACL)
8. object storage + async processing
9. recording capacity test (R1 → R2 → R3)
```

Không làm recording scale hoặc widget phức tạp trước khi **isolation + routing** ổn.

---

## 8. Mapping yêu cầu gốc → chốt

| Ý ban đầu | Chốt MVP |
|-----------|----------|
| Không nhảy phòng khám | I0 server-side authorize + test cross-clinic |
| Landing → đúng staff | Auto-dispatch longest-idle; 1 ring 1 staff |
| API nhúng | API ≠ Widget; site_key public; staff JWT riêng |
| 50 call / ghi hình | 50 **calls**; recording R1/R2/R3 riêng; scale worker |
| Chunk 15s | Không product req |
| Lưu video/audio/không | Mode trước call; default None/AudioOnly; retention sau |
| Ngoài giờ | `Closed` ngay, không queue |

---

## 9. Deliverables theo bước

| Bước | Output |
|------|--------|
| Design | Sequence + state machine (Closed/Queued/Ringing/InCall) |
| Implement | PR theo §7; isolation + one-staff-one-call trước widget |
| Capacity | `evidence/capacity-runs/recording-R1|R2|R3` + SUMMARY |

---

## 10. Liên quan

- PoC README: `../README.md`  
- Recording storage plan cũ: [recording-storage-development-plan.md](./recording-storage-development-plan.md) (cập nhật theo ADR TASK-003 khi chốt)  
- Handoff prompt: [PROMPTS/project-handoff.md](./PROMPTS/project-handoff.md)  
- Evidence quality: `../evidence/perf-real/2026-08-06-three-real-calls-analysis.md`

# TASK-003 — Multi-clinic call platform (backlog siết)

**Trạng thái:** Draft backlog (chưa implement)  
**Baseline:** TASK-002 LiveKit 1:1 PoC (`poc/livekit-1to1/`)  
**Repo:** SimlyDent-Internship · `main`  
**Cách đọc doc này:** mỗi hạng mục tách **Product requirement** · **Technical invariant** · **Acceptance criteria (AC)**. Không trộn ba lớp trong cùng một câu DoD mơ hồ.

---

## 0. Bốn invariant kiến trúc (không được phá)

Mọi design/PR sau này hỏi: *có phá invariant nào không?*

| # | Phase | Invariant |
|---|--------|-----------|
| I0 | Isolation | **Một clinic không bao giờ** đọc/ghi/subscribe call, media, recording, presence, queue của clinic khác. |
| I1 | Routing | **Tại mọi thời điểm:** một call có tối đa một agent được assign; một agent có tối đa một active call (MVP capacity = 1). |
| I2 | Embed | **API ≠ Widget.** Widget chỉ là client của Public Embed API. Browser **chỉ** nhận credential short-lived, scoped clinic; website clinic **không** biết routing/LiveKit secret/**không** tự chọn room. |
| I3 | Recording | Lỗi recording / post-process / storage **không** được terminate hoặc phá control path của live call. |

---

## 1. Bối cảnh & mục tiêu sản phẩm

### Product goal
Một hạ tầng cung cấp **video/audio call tư vấn** cho **nhiều phòng khám**. Mỗi clinic có landing/widget riêng; khách gọi đúng clinic; staff rảnh nhận call; có tùy chọn lưu cuộc gọi mà không làm sập live path.

### Baseline đã có (TASK-002)
- Call 1:1, JWT, tenant isolation cơ bản, SignalR invite, LiveKit SFU, Egress MP4 (VPS 2 vCPU đã hạ `cpu_cost`).
- Capacity + real-call evidence trên VPS/local.

### Ngoài scope TASK-003 (ghi rõ)
- App mobile native đầy đủ  
- AI transcript / chẩn đoán  
- Booking / CRM / thanh toán  
- Compliance platform hoàn chỉnh (chỉ **chỗ gắn** policy/consent/audit)

---

## 2. Quyết định kiến trúc — **cần sếp chốt** (block design)

Ba điểm ảnh hưởng mạnh; chốt trước khi implement sâu:

| ID | Câu hỏi | Option đề xuất (MVP) | Ảnh hưởng |
|----|---------|----------------------|-----------|
| **D1 Routing mode** | Auto-dispatch (backend gán agent) hay hunt-group claim (staff Accept, first wins)? | **Hunt-group claim** cho MVP; round-robin auto-dispatch phase sau | State machine, API Accept, UX staff |
| **D2 Recording decision** | Chọn mode **trước/trong call**, hay end call mới quyết định **giữ/xóa**? | **Policy trước/trong call** để scale; end call = *retention* (keep/delete) nếu đã record | CPU/storage 100% call vs “lưu sau” |
| **D3 Workload “50 concurrent”** | 50 call profile nào? | Benchmark **R1/R2/R3** (mục 6) trước khi cam kết số | Sizing VPS/worker/egress |

### Gợi ý wording phản hồi sếp

> Phần yêu cầu đã đúng hướng. Ba quyết định còn ảnh hưởng mạnh đến kiến trúc:  
> (1) routing dùng **auto-assign** hay **staff claim**,  
> (2) recording mode **chọn trước call** hay chỉ **giữ/xóa sau call**,  
> (3) **50 concurrent recording** benchmark ở **video profile** nào.  
> Chốt 3 câu đó → đủ rõ để thiết kế TASK-003 và implement ít lệch ý.

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
- MVP: **một agent ≤ 1 active call**; **một call ≤ 1 assigned agent**.  
- Claim/assign **atomic** trên server (critical section / compare-and-set / DB transaction).

### 4.1 Agent state machine (tối thiểu)

```text
Offline ──heartbeat/login──► Available
Available ──reserve/invite──► Ringing
Ringing ──accept──► InCall
Ringing ──reject/timeout/offline──► Available | Offline  (+ redispatch)
InCall ──end──► Available
* ──stale heartbeat──► Offline  (+ release reservation, redispatch visitor nếu cần)
```

Optional sau: `Away` / `Paused`.

**Vì sao cần `Ringing`:** nếu chỉ Available/InCall, lúc invitation đang bay agent vẫn Available → dispatcher gán call thứ hai → race.

Lease fields (khái niệm):

```text
state
connectionId
heartbeatAt
reservedCallId?   // set khi Ringing / InCall
```

### 4.2 Semantics routing — chọn **một** primary mode (D1)

| Mode | Flow | Phù hợp |
|------|------|---------|
| **Auto dispatch** | Queue → backend chọn agent → Ringing → timeout → agent khác | Call center |
| **Hunt-group claim** | Queue → nhiều staff thấy incoming → Accept → **first atomic win** → loser `AlreadyClaimed` | Clinic nhỏ |

**MVP đề xuất:** Hunt-group claim; backend đảm bảo first accept wins. Round-robin / auto-dispatch là phase sau — **không** thiết kế API lưng chừng cả hai.

### 4.3 Queue rules (MVP — chốt cứng)

| Rule | MVP default |
|------|-------------|
| Order | **FIFO** |
| Staff capacity | **1** |
| Agent ringing timeout | configurable (vd. 15s) |
| Visitor max wait | configurable (vd. 60–120s) |
| Reject | next available / rebroadcast theo mode đã chốt |
| Agent offline while Ringing | release + redispatch |
| Visitor cancel | remove khỏi queue, cancel ringing |
| Một visitor mở 2 call | **không** (1 active visitor session) |
| End call | agent → Available → **dispatch queue head** (nếu mode auto) hoặc staff sẵn claim call tiếp |

Call / queue states (product-facing): `Queued` · `Ringing` · `InCall` · `NoAgent` · `Timeout` · `Ended` · `Cancelled`.

### Acceptance criteria
- [ ] Không hai staff `InCall` cùng một visitor call  
- [ ] Không một staff nhận 2 call song song (MVP)  
- [ ] Race 2× Accept → đúng 1 win, 1 `AlreadyClaimed`  
- [ ] Heartbeat stale → Offline, nhả reservation, visitor được redispatch hoặc Timeout theo rule  
- [ ] Reject / ring timeout không “mất” visitor (redispatch hoặc terminal state rõ)  
- [ ] End call → agent Available trong SLA ngắn (vd. ≤ 2s path server)

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
- **Visitor (landing clinic):** nút nhỏ góc phải (“Tư vấn”) → tạo yêu cầu call vào **đúng clinic** của site đó.  
- **Staff:** login thật → nút góc phải + panel (góc trái) xem agents / queue / active calls, Accept/Reject.  
- Clinic chỉ chèn 1 đoạn; SimlyDent lo identify clinic → visitor session → queue → staff → SignalR → LiveKit token → call → (optional) recording policy → end.

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

### 5.7 Deliverables (thứ tự — widget sau API routing)

1. Phase 1 routing ổn → **Public Embed API** (`/embed/*`)  
2. Visitor widget (button BR + mini UI; iframe bootstrap)  
3. Staff console (button BR + panel trái, JWT + SignalR)  
4. Branding/config per clinic (logo, giờ, message bận)

**Không** làm widget trước routing API — tránh nhét business logic vào browser.

### Acceptance criteria
- [ ] Clinic chèn 1 snippet + `site_key` → nút gọi xuất hiện; call vào **đúng** clinic map từ key  
- [ ] Bấm gọi: network chỉ thấy `/embed/*` (và sau accept mới có LiveKit join); **không** lộ LiveKit API secret  
- [ ] Domain ngoài allowlist bị từ chối  
- [ ] Rate limit IP / 1 active call / session có smoke test  
- [ ] Staff JWT: Accept/Reject/queue chỉ clinic mình; B không thấy event A  
- [ ] Widget không tự chọn room name; room/token chỉ từ backend sau Accepted  
- [ ] (MVP) iframe (hoặc script→iframe) load được trên trang tĩnh demo

---

## 6. Phase 3 — Recording & storage

### Product requirement
Có tùy chọn liên quan lưu cuộc gọi; hệ thống chịu được nhiều call đồng thời **theo workload đã định nghĩa**; dung lượng kiểm soát được; không cần xem lại ngay.

### Technical invariant (I3)
- Capture media **phải** diễn ra **trong lúc call** (không “queue capture sau khi end”).  
- **Async** chỉ áp cho: upload finalization, transcode, audio extract, thumbnail, integrity, metadata, retention, archive/delete.  
- Recording/post-process/storage fail **không** drop live call.

### 6.1 Recording vs retention (D2)

| Approach | Ý nghĩa | Trade-off |
|----------|---------|-----------|
| **A. Record always → end decide keep** | End call = *retention* (keep video / keep audio / delete) | Tốn CPU/disk **100%** call kể cả khi delete |
| **B. Policy trước/trong call** | `None` / `AudioOnly` / `Video` → chỉ start pipeline cần thiết | Scale tốt; **không** “cuối call mới đòi video lúc nãy” nếu đã None |

**Wording đúng:** nếu sếp muốn “sau call mới chọn có giữ file” → gọi là **retention decision**, không gọi là recording decision — trừ khi A được chấp nhận chi phí.

**MVP đề xuất:** B (policy trước) + retention delete nếu staff/clinic hủy giữ file (khi đã record).

### 6.2 Chunk 15s — **không** phải product requirement

Chunk client 15s là **implementation idea**, không lock vào backlog.

**ADR bắt buộc** trước khi chọn:

- Server-side LiveKit Egress (baseline PoC đã chạy)  
- Segmented/chunk pipeline  
- Hybrid  

Baseline kiến trúc ưu tiên:

```text
Live media (critical path)
   │
   ├── call control + SFU
   │
   └── recording request (optional)
          │
          ▼
     egress / recording workers
          │
          ▼
     object storage
          │
          ▼
     async post-processing (transcode, audio-only extract, retention)
```

Client-side chunking chỉ xét nếu benchmark chứng minh giải quyết đúng bottleneck; tránh mặc định vì: mobile background, tab close, retry/dedupe, merge, codec variance.

### 6.3 Workload “50 concurrent” — biến thành scenario

Không cam kết “50 call” mơ hồ. Benchmark tối thiểu:

| Scenario | Workload |
|----------|----------|
| **R1** | 50 × 1:1 · 480p · 15 fps · room composite · duration giả định 30’ |
| **R2** | 50 × audio-only |
| **R3** | 20 video composite + 30 audio-only |

Đo: CPU, RAM, network in/out, disk write, object upload, recording start latency, failure rate, queue backlog depth, finalization latency.

### 6.4 Security / compliance hooks (chỗ gắn, không overbuild)

Architecture phải có chỗ cho:

- `RecordingPolicy` (per clinic / per call)  
- Consent  
- Encryption at rest  
- Signed download URL  
- Retention TTL  
- Audit log (who started/stopped/downloaded/deleted)  
- Access control (clinic-scoped)  
- Deletion  

PoC internship không cần full compliance; **không** hard-code path local-only không mở rộng được.

### Acceptance criteria
- [ ] ADR recording pipeline được review + chọn  
- [ ] Kill egress/worker giữa call → call vẫn InCall, media không forced hangup  
- [ ] Path storage namespaced `clinic/{id}/...`; cross-clinic download fail  
- [ ] Policy `None` không start egress; `AudioOnly`/`Video` start đúng loại (khi implement)  
- [ ] R1/R2/R3 report có số đo (kể cả “chưa đạt 50 video”)  
- [ ] Retention/delete job hoặc API stub có audit hook

---

## 7. Thứ tự triển khai (không song song 4 phase)

```text
1. Clinic isolation (I0 + AC cross-clinic)
      ↓
2. Agent state + atomic claim (I1, Ringing lease)
      ↓
3. Visitor queue + redispatch / timeout rules
      ↓
4. Public visitor API (site_key, allowlist, rate limit)
      ↓
5. Visitor widget
      ↓
6. Staff console widget
      ↓
7. Recording policy (+ retention wording)
      ↓
8. Object storage + async workers
      ↓
9. Recording capacity benchmark R1/R2/R3
```

---

## 8. Mapping “ý sếp” → backlog đã siết

| Ý sếp (gần đúng) | Product | Invariant | Ghi chú siết |
|------------------|---------|-----------|--------------|
| 1 server nhiều PK, không nhảy PK | Multi-clinic | I0 | Authorize server-side, không chỉ column |
| Landing → đúng staff, rảnh / sau end | Queue + agent state | I1 | `Ringing` + lease; chốt claim vs auto |
| “API nhúng” / nút landing + panel staff | **Public Embed API** + **Widget client** (+ Staff API JWT) | I2 | Tách API≠Widget; site_key public hẹp quyền; iframe MVP; widget sau routing |
| 50 ghi hình; chunk; queue; audio/video option | Storage scale | I3 | ADR; capture realtime; async = post; workload R1–R3; retention vs policy |

---

## 9. Deliverables tài liệu / code theo bước

| Bước | Output |
|------|--------|
| Chốt D1–D3 | Ghi vào mục 2 (update “Resolved”) |
| Design | Sequence: visitor click → queue → claim → media → end → (optional record) |
| Implement | PR nhỏ theo thứ tự mục 7; test isolation + claim race trước widget |
| Capacity | `evidence/capacity-runs/recording-*` + SUMMARY |

---

## 10. Liên quan

- PoC README: `../README.md`  
- Recording storage plan cũ: [recording-storage-development-plan.md](./recording-storage-development-plan.md) (cập nhật theo ADR TASK-003 khi chốt)  
- Handoff prompt: [PROMPTS/project-handoff.md](./PROMPTS/project-handoff.md)  
- Evidence quality: `../evidence/perf-real/2026-08-06-three-real-calls-analysis.md`

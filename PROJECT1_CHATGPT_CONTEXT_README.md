# Project 1 - Context Guide

## Scope hiện hành

Nghiên cứu giải pháp **open-source, self-hostable** để xây module video call 1:1 giữa hai nhân viên trên web, tùy biến sâu và không bắt buộc phụ thuộc hosted media/signaling service.

Không phải:

- Web-to-Phone/PSTN.
- Managed communication API comparison.
- Meeting-room embed mặc định.
- Recording hoặc group call trong core phase.

## Canonical reading order

1. `PROJECT1_INTERNAL_VIDEO_CALL_MODULE.md`
2. `internship-log/docs/06-tasks/TASK-002-research-web-video-call.md`
3. `internship-log/work/TASK-002-web-video-call/docs/bao-cao-nghien-cuu-video-call.md`
4. `internship-log/work/TASK-002-web-video-call/references/evidence-table.md`
5. `internship-log/work/TASK-002-web-video-call/references/source-log.md`
6. `internship-log/work/TASK-002-web-video-call/docs/candidate-spike-plan.md`

## Decision snapshot - 2026-08-05

- LiveKit self-host: preferred spike.
- mediasoup: maximum-customization comparator.
- Raw WebRTC + coturn: architecture/TURN baseline.
- Janus: conditional on GPL legal review.
- Jitsi/OpenVidu/full communication apps: screened out khỏi core PoC.
- Stringee: out of scope because managed-only; historical reference only.

No production winner has been selected. Desk research determines experiment order, not production qualification.

## Historical material

- `archive/PROJECT1_WEB_TO_PHONE_MODULE_OBSOLETE.md`: obsolete PSTN interpretation.
- `sources/research_video_call_module_20260804.md`: superseded raw memo.
- `tmp/` and ZIP context packages: snapshots, not canonical.

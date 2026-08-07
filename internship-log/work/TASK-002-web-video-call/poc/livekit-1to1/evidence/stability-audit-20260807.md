# Stability Audit ? 20260807

Generated: 2026-08-07T19:56:09+07:00

## Phase 0 ? Git state
```
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git checkout -- <file>..." to discard changes in working directory)

	modified:   internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/infra/Caddyfile.vps.runtime
	modified:   internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/scripts/start-vps.sh

Untracked files:
  (use "git add <file>..." to include in what will be committed)

	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/evidence/stability-audit-20260807.md
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_AvMG26SgPcS5.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_Baeqa7uuP3Yf.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_FFQz2CsZAt2U.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_JBHCrHyhWs2u.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_JNJ27LZA4Mcc.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_N2aPCy33kHkZ.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_f8SuHRdtbtTJ.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_fXs854eeiaib.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_otgNTycXWMGP.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_qeEubGz78zfF.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_qw75YxjjyLhs.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/EG_xba9FMG3C86w.json
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/audio-clinic-a-0fcf8708a68e406bbc68c53e8d7ce49b-5a0016a2593c4f3cbd56c9e9a8eb4e89.mp3
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/audio-clinic-a-6bc49da5769f4349af0b373abd07a65f-0701209eb4374af0bcad65942e9665b1.mp3
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/clinic/
	internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/recordings/recording-audit.jsonl

no changes added to commit (use "git add" and/or "git commit -a")
---
31b4a14 test(smoke): stagger egress modes; reject fake track SIDs for dental clip
257479a fix(media): materialize audio/clips from /out scan; add continuous media smoke
c1899e1 fix(dental): more reliable clip start — body bind, client track, preset encode
bf477b6 fix(egress): free capacity for manual video on 2 vCPU lab
5503da4 fix(media): photo capture works with local storage via API upload
494e1e8 fix(egress): lower cpu_cost so dual room composites fit 2 vCPU lab
e50631b fix(ui): restore staff scroll/sidebar layout and split video/audio call buttons
ba97200 fix(media): PascalCase MediaAssetInsert named args for C# compile
f9ca250 feat(media): consultation catalog M1-M5 — audio, dental clips, snapshots, Manager UI
cc6dd20 fix(ui): share fetchAndSaveRecording across portal and call window apps
f699744 docs(evidence): correct health-local after Phase C rollback
c4d8874 chore(evidence): remove full presigned URLs from Phase C artifacts
2d80785 docs(evidence): Phase C Direct S3 VPS E2E proof and fix mc bootstrap entrypoint
bda6be5 feat(recording): Phase C Direct S3 lab scaffolding
ef5bdba feat(recording): presign download-url, DB retention, S3 endpoint split
---
HEAD=31b4a14d2df8aaa60413b3ccc378a2b4f68ff679
---
origin	https://github.com/GrootTheDeveloper/SimlyDent-Internship.git (fetch)
origin	https://github.com/GrootTheDeveloper/SimlyDent-Internship.git (push)
```

## Phase 1 ? Machine
```
Fri Aug  7 19:56:09 +07 2026
vpssieutoc.1785946678
Linux vpssieutoc.1785946678 4.15.0-22-generic #24-Ubuntu SMP Wed May 16 12:15:17 UTC 2018 x86_64 x86_64 x86_64 GNU/Linux
--- nproc ---
2
--- lscpu ---
Architecture:        x86_64
CPU op-mode(s):      32-bit, 64-bit
Byte Order:          Little Endian
CPU(s):              2
On-line CPU(s) list: 0,1
Thread(s) per core:  1
Core(s) per socket:  2
Socket(s):           1
NUMA node(s):        1
Vendor ID:           GenuineIntel
CPU family:          6
Model:               85
Model name:          Intel(R) Xeon(R) Gold 6148 CPU @ 2.40GHz
Stepping:            4
CPU MHz:             2394.374
BogoMIPS:            4788.74
Virtualization:      VT-x
Hypervisor vendor:   KVM
Virtualization type: full
L1d cache:           32K
L1i cache:           32K
L2 cache:            4096K
L3 cache:            16384K
NUMA node0 CPU(s):   0,1
Flags:               fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm constant_tsc arch_perfmon rep_good nopl xtopology cpuid pni pclmulqdq vmx ssse3 fma cx16 pdcm pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch cpuid_fault invpcid_single pti tpr_shadow vnmi flexpriority ept vpid fsgsbase tsc_adjust bmi1 hle avx2 smep bmi2 erms invpcid rtm mpx avx512f avx512dq rdseed adx smap clflushopt clwb avx512cd avx512bw avx512vl xsaveopt xsavec xgetbv1 xsaves ibpb ibrs stibp arat umip pku ospke arch_capabilities ssbd
--- uptime ---
 19:56:09 up 1 day, 20:33,  0 users,  load average: 0.17, 0.17, 0.17
--- free ---
              total        used        free      shared  buff/cache   available
Mem:           3.9G        920M        985M         98M        2.0G        2.6G
Swap:          2.0G        524K        2.0G
--- swap ---
NAME      TYPE SIZE USED PRIO
/swapfile file   2G 524K   -2
--- df -h ---
Filesystem      Size  Used Avail Use% Mounted on
udev            1.9G     0  1.9G   0% /dev
tmpfs           395M   50M  346M  13% /run
/dev/vda1        50G   12G   36G  24% /
tmpfs           2.0G     0  2.0G   0% /dev/shm
tmpfs           5.0M     0  5.0M   0% /run/lock
tmpfs           2.0G     0  2.0G   0% /sys/fs/cgroup
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/6a0b59eb760b93e8c65229fe991b81ba7d644d40c4dc009eb403bfe0d25b69ac/merged
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/8523dfcb9e33f2501858202a3156f57190e8c8f345ba5898d4f0a30a00a861f4/merged
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/88aa62627ae1f269c8aa59131da4c900c2714c03ee738356455f933551328930/merged
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/5de981743c46dfbe5bc2a43bf06711c6ae7a5f0eb20ba46c3c19e32a74580c53/merged
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/9254552a73247192ed1ef9dde4be647022e9d631e5d8a7f659c08212d5e2b8a8/merged
tmpfs           395M     0  395M   0% /run/user/0
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/2802004d506da1815e14b643fdf17a6a96f076a1826ac0a1f4d16f158a485b97/merged
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/07e8d74b073d5cd47ab343f857b2ecee4602d5e8eb0d0ab6a1b43afb988ac5f9/merged
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/fb397e3c51806eb5828a53ccdc5a2b923981122f6c068e80812637987da8b8d8/merged
overlay          50G   12G   36G  24% /var/lib/docker/overlay2/0e967542b4f44bf560f854818afe2ef98458254f1a5e690dde4034d435ffad17/merged
--- df -i ---
Filesystem      Inodes  IUsed   IFree IUse% Mounted on
udev            498061    397  497664    1% /dev
tmpfs           504933   2780  502153    1% /run
/dev/vda1      3193600 198164 2995436    7% /
tmpfs           504933      1  504932    1% /dev/shm
tmpfs           504933      2  504931    1% /run/lock
tmpfs           504933     18  504915    1% /sys/fs/cgroup
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/6a0b59eb760b93e8c65229fe991b81ba7d644d40c4dc009eb403bfe0d25b69ac/merged
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/8523dfcb9e33f2501858202a3156f57190e8c8f345ba5898d4f0a30a00a861f4/merged
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/88aa62627ae1f269c8aa59131da4c900c2714c03ee738356455f933551328930/merged
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/5de981743c46dfbe5bc2a43bf06711c6ae7a5f0eb20ba46c3c19e32a74580c53/merged
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/9254552a73247192ed1ef9dde4be647022e9d631e5d8a7f659c08212d5e2b8a8/merged
tmpfs           504933     11  504922    1% /run/user/0
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/2802004d506da1815e14b643fdf17a6a96f076a1826ac0a1f4d16f158a485b97/merged
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/07e8d74b073d5cd47ab343f857b2ecee4602d5e8eb0d0ab6a1b43afb988ac5f9/merged
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/fb397e3c51806eb5828a53ccdc5a2b923981122f6c068e80812637987da8b8d8/merged
overlay        3193600 198164 2995436    7% /var/lib/docker/overlay2/0e967542b4f44bf560f854818afe2ef98458254f1a5e690dde4034d435ffad17/merged
```

## Top processes CPU
```
USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root     28416  4.2  1.7 1282852 71952 ?       Ssl  13:53  15:34 /lk room join --url ws://livekit:7880 --api-key devkey --api-secret x1VnWuZrs87dD4TKfVuhbw+GEx7b522nnndjR1kbfKBKlOPP --identity phase-c-publisher --publish-demo clinic:clinic-a:call:da0eba144fdd4ac494a6bb5ef8530ac4
root     23605  3.0  2.5 1380308 104332 ?      Ssl  11:47  14:55 /livekit-server --config /etc/livekit.yaml --node-ip 103.28.32.118
999      13046  0.8  0.2  39888  9396 ?        Ssl  Aug05  22:27 redis-server *:6379
root      5870  0.5  4.6 274088052 189716 ?    Ssl  17:23   0:46 dotnet LiveKitPoc.Api.dll
root     11467  0.4  5.2 3127144 211136 ?      Ssl  Aug05  11:11 /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
root     20685  0.2  7.5 1672900 305532 ?      Ssl  13:47   0:47 minio server /data --console-address :9001
root         8  0.1  0.0      0     0 ?        I    Aug05   3:13 [rcu_sched]
1001      2878  0.1  1.5 1973868 64448 ?       Sl   17:21   0:10 egress
root     10437  0.1  1.2 1437792 51800 ?       Ssl  Aug05   3:01 /usr/bin/containerd
root     22512  0.1  0.2 720756 11228 ?        Sl   11:47   0:41 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 448d3ddaef85bb03dd826bd62293a6110449a21a5e9a2747c769648faafe2f91 -address /run/containerd/containerd.sock
root         1  0.0  0.2 159664  9000 ?        Ss   Aug05   0:53 /sbin/init splash
root         2  0.0  0.0      0     0 ?        S    Aug05   0:00 [kthreadd]
root         4  0.0  0.0      0     0 ?        I<   Aug05   0:00 [kworker/0:0H]
root         6  0.0  0.0      0     0 ?        I<   Aug05   0:00 [mm_percpu_wq]
root         7  0.0  0.0      0     0 ?        S    Aug05   0:06 [ksoftirqd/0]
root         9  0.0  0.0      0     0 ?        I    Aug05   0:00 [rcu_bh]
root        10  0.0  0.0      0     0 ?        S    Aug05   0:00 [migration/0]
root        11  0.0  0.0      0     0 ?        S    Aug05   0:00 [watchdog/0]
root        12  0.0  0.0      0     0 ?        S    Aug05   0:00 [cpuhp/0]
root        13  0.0  0.0      0     0 ?        S    Aug05   0:00 [cpuhp/1]
root        14  0.0  0.0      0     0 ?        S    Aug05   0:00 [watchdog/1]
root        15  0.0  0.0      0     0 ?        S    Aug05   0:00 [migration/1]
root        16  0.0  0.0      0     0 ?        S    Aug05   0:20 [ksoftirqd/1]
root        18  0.0  0.0      0     0 ?        I<   Aug05   0:00 [kworker/1:0H]
root        19  0.0  0.0      0     0 ?        S    Aug05   0:00 [kdevtmpfs]
root        20  0.0  0.0      0     0 ?        I<   Aug05   0:00 [netns]
root        21  0.0  0.0      0     0 ?        S    Aug05   0:00 [rcu_tasks_kthre]
root        22  0.0  0.0      0     0 ?        S    Aug05   0:00 [kauditd]
root        25  0.0  0.0      0     0 ?        S    Aug05   0:00 [khungtaskd]
```

## Top processes MEM
```
USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root     20685  0.2  7.5 1672900 305532 ?      Ssl  13:47   0:47 minio server /data --console-address :9001
root     11467  0.4  5.2 3127144 211136 ?      Ssl  Aug05  11:11 /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
root      5870  0.5  4.6 274088052 189716 ?    Ssl  17:23   0:46 dotnet LiveKitPoc.Api.dll
root     23605  3.0  2.5 1380308 104332 ?      Ssl  11:47  14:55 /livekit-server --config /etc/livekit.yaml --node-ip 103.28.32.118
root     28416  4.2  1.7 1282852 71952 ?       Ssl  13:53  15:34 /lk room join --url ws://livekit:7880 --api-key devkey --api-secret x1VnWuZrs87dD4TKfVuhbw+GEx7b522nnndjR1kbfKBKlOPP --identity phase-c-publisher --publish-demo clinic:clinic-a:call:da0eba144fdd4ac494a6bb5ef8530ac4
1001      2878  0.1  1.5 1973868 64448 ?       Sl   17:21   0:10 egress
root     10437  0.1  1.2 1437792 51800 ?       Ssl  Aug05   3:01 /usr/bin/containerd
root      6161  0.0  1.1 1308532 47660 ?       Ssl  17:23   0:02 caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
70       22559  0.0  0.6 174640 27008 ?        Ss   11:47   0:05 postgres
root       227  0.0  0.5  97640 20216 ?        S<s  Aug05   0:48 /lib/systemd/systemd-journald
root       334  0.0  0.4 170460 17004 ?        Ssl  Aug05   0:00 /usr/bin/python3 /usr/bin/networkd-dispatcher
70       18558  0.0  0.3 177668 15828 ?        Ss   19:53   0:00 postgres: simlydent simlydent 172.18.0.6(58818) idle
1001      2874  0.0  0.2 315644 11796 ?        Sl   17:21   0:00 pulseaudio -D --verbose --exit-idle-time=-1 --disallow-exit
root     22512  0.1  0.2 720756 11228 ?        Sl   11:47   0:41 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 448d3ddaef85bb03dd826bd62293a6110449a21a5e9a2747c769648faafe2f91 -address /run/containerd/containerd.sock
root     13018  0.0  0.2 720756 10528 ?        Sl   Aug05   0:13 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 8426adfd6ecc7ebd6f389e5f5da20996d0f0f8874192417e6e6fe5c9d65648cb -address /run/containerd/containerd.sock
root      5956  0.0  0.2 720756 10356 ?        Sl   17:23   0:00 /usr/bin/containerd-shim-runc-v2 -namespace moby -id b68ef3f44d8952199c51173ca042ae76e9271e542068ece87d76253371b8025b -address /run/containerd/containerd.sock
root     23580  0.0  0.2 720756 10340 ?        Sl   11:47   0:03 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 86ec0d6badf1ac4c63e9072e70c30adf34cb09b6463b4fe1a6f9e62e3d9b158a -address /run/containerd/containerd.sock
70       22734  0.0  0.2 174816 10324 ?        Ss   11:47   0:00 postgres: checkpointer
root     20657  0.0  0.2 720500 10140 ?        Sl   13:47   0:01 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 6ba60b27232668a8414d65f3ecdaa6dd6ffc8598236e612d3adaa5eadafa602e -address /run/containerd/containerd.sock
root     28385  0.0  0.2 720756 10104 ?        Sl   13:53   0:02 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 776d43461413406455b4570a9cf44a2ec218adc2b7c796815e3b593ad59ba668 -address /run/containerd/containerd.sock
root      6130  0.0  0.2 720500  9968 ?        Sl   17:23   0:00 /usr/bin/containerd-shim-runc-v2 -namespace moby -id a7e38084b9942029c038400b58ad6d98645399ca1bcc21027be0e567b4710a64 -address /run/containerd/containerd.sock
root      5842  0.0  0.2 720500  9952 ?        Sl   17:23   0:01 /usr/bin/containerd-shim-runc-v2 -namespace moby -id fab4d07c7060cae0b003fb33898c43ff4d2bfb42648672e705b41f1934ce15ce -address /run/containerd/containerd.sock
root      2792  0.0  0.2 720500  9940 ?        Sl   17:21   0:00 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 67e805c41883eb4be71150348a38b4ece3f33c7b5f6897fb6e863c72bd61b897 -address /run/containerd/containerd.sock
999      13046  0.8  0.2  39888  9396 ?        Ssl  Aug05  22:27 redis-server *:6379
70       22737  0.0  0.2 174704  9060 ?        Ss   11:47   0:00 postgres: walwriter
root         1  0.0  0.2 159664  9000 ?        Ss   Aug05   0:53 /sbin/init splash
root     29021  0.0  0.1  76720  7812 ?        Ss   17:12   0:07 /lib/systemd/systemd --user
70       22738  0.0  0.1 176320  7376 ?        Ss   11:47   0:00 postgres: autovacuum launcher
root     19367  0.0  0.1 107992  6928 ?        Ss   19:56   0:00 sshd: root@notty
```

## Target processes
```
1001      2824  0.0  0.0   2680  1112 ?        Ss   17:21   0:00 /tini -- egress
1001      2878  0.1  1.5 1973868 64448 ?       Sl   17:21   0:10 egress
root      3702  0.0  0.0  12884  3288 ?        Ss   17:21   0:00 bash -c while pgrep -f 'smoke-media-e2e.sh' >/dev/null 2>&1; do sleep 10; done; echo DONE; cat /tmp/smoke-media-e2e.out; echo ---PG---; docker exec livekit-1to1-postgres-1 psql -U simlydent -d simlydent -c 'SELECT kind, status, count(*) FROM media_assets GROUP BY 1,2 ORDER BY 1,2;'
root      5870  0.5  4.6 274088052 189716 ?    Ssl  17:23   0:46 dotnet LiveKitPoc.Api.dll
root      6161  0.0  1.1 1308532 47660 ?       Ssl  17:23   0:02 caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
999      13046  0.8  0.2  39888  9396 ?        Ssl  Aug05  22:27 redis-server *:6379
70       18558  0.0  0.3 177668 15828 ?        Ss   19:53   0:00 postgres: simlydent simlydent 172.18.0.6(58818) idle
root     19432  0.0  0.0  14560  2660 ?        S    19:56   0:00 grep -E -i livekit|egress|chrome|chromium|ffmpeg|postgres|redis|caddy|dotnet
70       22559  0.0  0.6 174640 27008 ?        Ss   11:47   0:05 postgres
70       22734  0.0  0.2 174816 10324 ?        Ss   11:47   0:00 postgres: checkpointer
70       22735  0.0  0.1 174736  5020 ?        Ss   11:47   0:00 postgres: background writer
70       22737  0.0  0.2 174704  9060 ?        Ss   11:47   0:00 postgres: walwriter
70       22738  0.0  0.1 176320  7376 ?        Ss   11:47   0:00 postgres: autovacuum launcher
70       22739  0.0  0.1 176240  5632 ?        Ss   11:47   0:00 postgres: logical replication launcher
root     23605  3.0  2.5 1380308 104332 ?      Ssl  11:47  14:55 /livekit-server --config /etc/livekit.yaml --node-ip 103.28.32.118
root     28416  4.2  1.7 1282852 71952 ?       Ssl  13:53  15:34 /lk room join --url ws://livekit:7880 --api-key devkey --api-secret x1VnWuZrs87dD4TKfVuhbw+GEx7b522nnndjR1kbfKBKlOPP --identity phase-c-publisher --publish-demo clinic:clinic-a:call:da0eba144fdd4ac494a6bb5ef8530ac4
root     30744  0.0  0.0  12884  3244 ?        Ss   17:13   0:02 bash -c while pgrep -f 'npm run build' >/dev/null 2>&1; do sleep 3; done; tail -15 /tmp/fe-clip.log; cd /opt/SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1; set -a; . ./.env; set +a; docker compose -f docker-compose.vps.yml up -d --no-deps --force-recreate frontend; sleep 2; docker ps --filter name=frontend --format '{{.Names}} {{.Status}}'
```

## Docker inventory
```
CONTAINER ID   IMAGE                                      COMMAND                  CREATED        STATUS                 PORTS                                                                                                                                                                                                    NAMES
a7e38084b994   caddy:2.11.4-alpine                        "caddy run --config …"   3 hours ago    Up 3 hours             0.0.0.0:80->80/tcp, :::80->80/tcp, 0.0.0.0:443->443/tcp, :::443->443/tcp, 443/udp, 2019/tcp                                                                                                              livekit-1to1-gateway-1
b68ef3f44d89   livekit-1to1-frontend                      "/docker-entrypoint.…"   3 hours ago    Up 3 hours             80/tcp                                                                                                                                                                                                   livekit-1to1-frontend-1
fab4d07c7060   livekit-1to1-backend                       "dotnet LiveKitPoc.A…"   3 hours ago    Up 3 hours             8080/tcp                                                                                                                                                                                                 livekit-1to1-backend-1
67e805c41883   livekit/egress:v1.12.0                     "/entrypoint.sh"         3 hours ago    Up 3 hours                                                                                                                                                                                                                      livekit-1to1-egress-1
776d43461413   livekit/livekit-cli:v2.4.2                 "/lk room join --url…"   6 hours ago    Up 6 hours                                                                                                                                                                                                                      lk-publisher
6ba60b272326   minio/minio:RELEASE.2025-04-22T22-12-26Z   "/usr/bin/docker-ent…"   6 hours ago    Up 6 hours             9000/tcp                                                                                                                                                                                                 livekit-1to1-minio-1
448d3ddaef85   postgres:16-alpine                         "docker-entrypoint.s…"   8 hours ago    Up 8 hours (healthy)   5432/tcp                                                                                                                                                                                                 livekit-1to1-postgres-1
86ec0d6badf1   livekit/livekit-server:v1.13.1             "/livekit-server --c…"   8 hours ago    Up 8 hours             0.0.0.0:3478->3478/tcp, :::3478->3478/tcp, 0.0.0.0:3478->3478/udp, :::3478->3478/udp, 0.0.0.0:7881->7881/tcp, 0.0.0.0:50000-50050->50000-50050/udp, :::7881->7881/tcp, :::50000-50050->50000-50050/udp   livekit-1to1-livekit-1
8426adfd6ecc   redis:7.4-alpine                           "docker-entrypoint.s…"   44 hours ago   Up 44 hours            6379/tcp                                                                                                                                                                                                 livekit-1to1-redis-1
---
CONTAINER ID   IMAGE                                      COMMAND                  CREATED        STATUS                 PORTS                                                                                                                                                                                                    NAMES
a7e38084b994   caddy:2.11.4-alpine                        "caddy run --config …"   3 hours ago    Up 3 hours             0.0.0.0:80->80/tcp, :::80->80/tcp, 0.0.0.0:443->443/tcp, :::443->443/tcp, 443/udp, 2019/tcp                                                                                                              livekit-1to1-gateway-1
b68ef3f44d89   livekit-1to1-frontend                      "/docker-entrypoint.…"   3 hours ago    Up 3 hours             80/tcp                                                                                                                                                                                                   livekit-1to1-frontend-1
fab4d07c7060   livekit-1to1-backend                       "dotnet LiveKitPoc.A…"   3 hours ago    Up 3 hours             8080/tcp                                                                                                                                                                                                 livekit-1to1-backend-1
67e805c41883   livekit/egress:v1.12.0                     "/entrypoint.sh"         3 hours ago    Up 3 hours                                                                                                                                                                                                                      livekit-1to1-egress-1
776d43461413   livekit/livekit-cli:v2.4.2                 "/lk room join --url…"   6 hours ago    Up 6 hours                                                                                                                                                                                                                      lk-publisher
6ba60b272326   minio/minio:RELEASE.2025-04-22T22-12-26Z   "/usr/bin/docker-ent…"   6 hours ago    Up 6 hours             9000/tcp                                                                                                                                                                                                 livekit-1to1-minio-1
448d3ddaef85   postgres:16-alpine                         "docker-entrypoint.s…"   8 hours ago    Up 8 hours (healthy)   5432/tcp                                                                                                                                                                                                 livekit-1to1-postgres-1
86ec0d6badf1   livekit/livekit-server:v1.13.1             "/livekit-server --c…"   8 hours ago    Up 8 hours             0.0.0.0:3478->3478/tcp, :::3478->3478/tcp, 0.0.0.0:3478->3478/udp, :::3478->3478/udp, 0.0.0.0:7881->7881/tcp, 0.0.0.0:50000-50050->50000-50050/udp, :::7881->7881/tcp, :::50000-50050->50000-50050/udp   livekit-1to1-livekit-1
8426adfd6ecc   redis:7.4-alpine                           "docker-entrypoint.s…"   44 hours ago   Up 44 hours            6379/tcp                                                                                                                                                                                                 livekit-1to1-redis-1
---
CONTAINER ID   NAME                      CPU %     MEM USAGE / LIMIT     MEM %     NET I/O           BLOCK I/O         PIDS
a7e38084b994   livekit-1to1-gateway-1    0.00%     12.85MiB / 3.852GiB   0.33%     6.32MB / 3.01MB   1.04MB / 16.4kB   9
b68ef3f44d89   livekit-1to1-frontend-1   0.00%     3.98MiB / 3.852GiB    0.10%     91.9kB / 5.13MB   500kB / 4.1kB     3
fab4d07c7060   livekit-1to1-backend-1    0.27%     109.7MiB / 3.852GiB   2.78%     2.56MB / 1.52MB   0B / 0B           20
67e805c41883   livekit-1to1-egress-1     0.12%     27.86MiB / 3.852GiB   0.71%     11MB / 311kB      152kB / 24.6MB    14
776d43461413   lk-publisher              5.67%     38.57MiB / 3.852GiB   0.98%     15.7MB / 5.56GB   0B / 0B           9
6ba60b272326   livekit-1to1-minio-1      0.03%     241.4MiB / 3.852GiB   6.12%     4.57MB / 3.74MB   20.5kB / 29.2MB   10
448d3ddaef85   livekit-1to1-postgres-1   0.00%     26.54MiB / 3.852GiB   0.67%     3MB / 3.03MB      2.32MB / 6.5MB    7
86ec0d6badf1   livekit-1to1-livekit-1    3.47%     61.76MiB / 3.852GiB   1.57%     6.07GB / 390MB    0B / 0B           11
8426adfd6ecc   livekit-1to1-redis-1      0.77%     5.797MiB / 3.852GiB   0.15%     159MB / 129MB     1.99MB / 0B       6
---
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          78        9         4.798GB   1.354GB (28%)
Containers      9         9         1.513MB   0B (0%)
Local Volumes   5         5         52.4MB    0B (0%)
Build Cache     324       0         1.037GB   1.037GB
--- names ---
a7e38084b994	livekit-1to1-gateway-1	caddy:2.11.4-alpine	Up 3 hours
b68ef3f44d89	livekit-1to1-frontend-1	livekit-1to1-frontend	Up 3 hours
fab4d07c7060	livekit-1to1-backend-1	livekit-1to1-backend	Up 3 hours
67e805c41883	livekit-1to1-egress-1	livekit/egress:v1.12.0	Up 3 hours
776d43461413	lk-publisher	livekit/livekit-cli:v2.4.2	Up 6 hours
6ba60b272326	livekit-1to1-minio-1	minio/minio:RELEASE.2025-04-22T22-12-26Z	Up 6 hours
448d3ddaef85	livekit-1to1-postgres-1	postgres:16-alpine	Up 8 hours (healthy)
86ec0d6badf1	livekit-1to1-livekit-1	livekit/livekit-server:v1.13.1	Up 8 hours
8426adfd6ecc	livekit-1to1-redis-1	redis:7.4-alpine	Up 44 hours
--- networks ---
NETWORK ID     NAME                   DRIVER    SCOPE
033c74889cf4   bridge                 bridge    local
cb7da19e2a45   host                   host      local
4fc4c894fa67   livekit-1to1_default   bridge    local
f39297755f7b   none                   null      local
--- volumes ---
DRIVER    VOLUME NAME
local     7e933d4eeb711b477e163b374f7e20c025af0c56942203a3b3551e0305703596
local     livekit-1to1_caddy_config
local     livekit-1to1_caddy_data
local     livekit-1to1_minio_data
local     livekit-1to1_postgres_data
```

## Container restart / OOM
```
/livekit-1to1-gateway-1 restart=0 status=running oom=false started=2026-08-07T10:23:32.664619443Z
/livekit-1to1-frontend-1 restart=0 status=running oom=false started=2026-08-07T10:23:31.843389352Z
/livekit-1to1-backend-1 restart=0 status=running oom=false started=2026-08-07T10:23:31.059707986Z
/livekit-1to1-egress-1 restart=0 status=running oom=false started=2026-08-07T10:21:04.436360918Z
/lk-publisher restart=0 status=running oom=false started=2026-08-07T06:53:25.060211672Z
/livekit-1to1-minio-1 restart=0 status=running oom=false started=2026-08-07T06:47:01.810845904Z
/livekit-1to1-postgres-1 restart=0 status=running oom=false started=2026-08-07T04:47:38.082355483Z
/livekit-1to1-livekit-1 restart=0 status=running oom=false started=2026-08-07T04:47:40.46429472Z
/livekit-1to1-redis-1 restart=0 status=running oom=false started=2026-08-05T16:38:20.831807213Z
```

## Kernel OOM (dmesg)
```
dmesg unavailable or empty
```

## Kernel journal 24h
```
journalctl empty/unavailable
```

## Docker journal 2h
```
-- Logs begin at Fri 2026-08-07 03:01:54 +07, end at Fri 2026-08-07 19:56:08 +07. --
-- No entries --
```

## Deploy after P0 fix
- commit: 3d7ccca28198a1ef7c3253a33b5392846d12abd5
- time: 2026-08-07T20:03:38+07:00
- stopped orphan lk-publisher (was 5-6% CPU + 5.6GB egress net to LiveKit)
- initialMediaMode API verified: Audio create ? CallView.initialMediaMode=Audio for both parties

## Baseline resources after cleanup (idle)
```
 20:03:38 up 1 day, 20:40,  1 user,  load average: 0.69, 0.42, 0.26
              total        used        free      shared  buff/cache   available
Mem:           3.9G        874M        866M         88M        2.2G        2.6G
Swap:          2.0G        524K        2.0G
CONTAINER ID   NAME                      CPU %     MEM USAGE / LIMIT     MEM %     NET I/O           BLOCK I/O         PIDS
ceeeba380bed   livekit-1to1-frontend-1   0.00%     3.859MiB / 3.852GiB   0.10%     768B / 0B         0B / 4.1kB        3
0069a440a684   livekit-1to1-backend-1    0.21%     51.27MiB / 3.852GiB   1.30%     50.8kB / 48.5kB   36.9kB / 0B       21
a7e38084b994   livekit-1to1-gateway-1    0.00%     13.41MiB / 3.852GiB   0.34%     6.4MB / 3.13MB    1.04MB / 16.4kB   9
67e805c41883   livekit-1to1-egress-1     0.11%     27.86MiB / 3.852GiB   0.71%     11MB / 312kB      152kB / 24.6MB    14
6ba60b272326   livekit-1to1-minio-1      0.02%     241.4MiB / 3.852GiB   6.12%     4.57MB / 3.74MB   20.5kB / 29.7MB   10
448d3ddaef85   livekit-1to1-postgres-1   0.01%     27.03MiB / 3.852GiB   0.69%     3.05MB / 3.11MB   2.32MB / 6.52MB   7
86ec0d6badf1   livekit-1to1-livekit-1    0.18%     45.45MiB / 3.852GiB   1.15%     6.15GB / 390MB    0B / 0B           11
8426adfd6ecc   livekit-1to1-redis-1      0.97%     5.805MiB / 3.852GiB   0.15%     159MB / 129MB     1.99MB / 0B       6
```

## Isolation notes
- FEATURE_AUTO_CALL_AUDIO=1
- egress cpu_cost still lab-lowered (scheduler accounting only)
- No OOM/restart on containers at audit time
- Disk recordings: 187M / 42 files

## Concurrent Egress test (2026-08-07T20:04+07)

Call: `366a652e-6be5-4974-8fac-6753e9c7a359` (no browser participants joined LiveKit)

| Step | Result |
|------|--------|
| Accept + consent | CallAudio asset `Recording` EG_kgdyvdnMu2hB |
| Concurrent legacy Video room composite | HTTP 200, EG_4hrHYBnkt9st validated (admission OK due to low cpu_cost) |
| Dental clip without camera | HTTP 409 correct reject |
| Hold 25s | egress CPU ~9?17%, mem ~377?406 MiB; load avg peak ~1.5 on 2 vCPU |
| Call end | both egress `Start signal not received` (Chrome never START_RECORDING ? empty room) |

**Interpretation:** Scheduler admitted dual room composites because `cpu_cost` values are lab-lowered. This does **not** prove dual Chrome/ffmpeg encoding is healthy with live A/V participants. Prior lab failures (`no response from servers`) remain capacity evidence when real media is present.

## Stale process cleanup

| Item | Evidence | Action |
|------|----------|--------|
| `lk-publisher` | 6h+ demo publish, ~5.7% CPU, ~5.6GB net out; LiveKit handling multi-GB | Documented then `docker stop/rm` |
| After cleanup | LiveKit CPU ~0.5% idle | Done |

## Root cause answers

### 1. Why did Audio call enable camera?
- Initial media was **client-only**: URL `?media=` + `sessionStorage`.
- Callee `acceptCall()` defaulted to `sessionStorage || 'video'` ? **not** caller?s Audio choice.
- Opening `/call/{id}` without `media=audio` ? `createLocalTracks({video: true})`.

### 2. Is initial media mode authoritative server-side?
- **After fix (3d7ccca): YES.** `CallSession.InitialMediaMode` set at create; exposed on `CallView.initialMediaMode`.
- Verified: A1 creates Audio ? A2 GET sees `initialMediaMode: Audio`.
- Consultation catalog now uses call?s mode (was hardcoded `"Audio"`).

### 3. Why did Audio?Video toggle fail?
- `toggleCamera` flipped Vue `cameraEnabled` **before** LiveKit op; no reconcile.
- Audio-only join used `video: false` tracks; optimistic UI could desync from publication.
- Fix: `ensureCameraEnabled` ? `setCameraEnabled` ? re-read publication ? UI.

### 4. What caused random call termination?
- **Primary FE bug:** `RoomEvent.Disconnected` ? `handleCallEnded()` ? close/navigate.
- Treated WebRTC media loss as business call end.
- LiveKit logs also show short sessions + `CLIENT_REQUEST_LEAVE` (user/UI leave) and DTLS timeouts under load.
- **Fix:** reconnect-aware; only business terminal status or intentional hangup ends call UI.

### 5. Did VPS CPU/RAM hit saturation?
- Idle after cleanup: load ~0.2, RAM available ~2.6G/3.9G, swap ~0.
- Dual empty-room egress: load ~1.5/2, egress mem ~400MB ? not full saturation.
- Historical concurrent **live** egress: `no response from servers` (commits 494e1e8/bf477b6).
- Realtime SFU alone scales to many rooms; **Egress Chrome** is the bottleneck.

### 6. Stale Chrome/Egress/container processes?
- Egress idle: pulseaudio + egress only (no orphan Chrome between jobs).
- **Stale `lk-publisher`** was the main orphan (removed).

### 7. Container restart/OOM?
- All `restart=0`, `oom=false` at audit.
- No kernel OOM in dmesg/journal for window inspected.

### 8. Can 2-vCPU run auto audio + dental + realtime stably?
- **Not reliably for production.** Dual room-composite Chrome + LiveKit + participants exceeds lab comfort zone.
- TrackComposite dental + audio_only room composite is lighter than dual full video composites but still competes for 2 vCPU.
- Product requirement concurrency is **capacity-limited** on this host ? classify **INFRA CAPACITY FAILURE** when overloaded; do not further lower `cpu_cost` as ?fix?.

### 9. Minimum deployment change?
1. **Separate Egress worker** (?2?4 vCPU dedicated) **or**
2. Resize single node to **?4 vCPU / ?8 GB RAM** for one concurrent dual-egress consultation, **or**
3. Temporary lab-only: `FEATURE_AUTO_CALL_AUDIO=0` when testing dental (documented workaround, not product fix).

## Fixes applied (commit 3d7ccca)

| Fix | Scope |
|-----|--------|
| `InitialMediaMode` on CallSession/CallView | Backend |
| Create call/queue body `initialMediaMode` | API |
| FE reads server mode; accept/reopen use it | Frontend |
| `ensureCameraEnabled` + publication reconcile | Frontend |
| Disconnect ? call end; reconnect logging | Frontend |
| Stop stale `lk-publisher` | Ops |

## Remaining risks

- Browser E2E A/V toggle not fully re-run in this agent session (API + code path verified).
- Empty-room auto audio often aborts without START_RECORDING if participants never join.
- `cpu_cost` still artificially low (admission hack) ? mark as lab only.
- Staggered smoke script still not product capacity proof.
- Dual legacy video recording + auto CallAudio still heavy.

## Issue table

| Issue | Root cause | Evidence | Fix | Verified? | Remaining risk |
|-------|------------|----------|-----|-----------|----------------|
| Audio enables camera | Client-only media; callee default video | Code acceptCall/sessionStorage; no server mode pre-fix | Server `initialMediaMode` + FE derive | API yes; browser partial | Embed path needs same discipline |
| A/V toggle unstable | Optimistic Vue flip; no LiveKit reconcile | toggleCamera pre-fix | ensureCameraEnabled | Code review yes | Device permission edge cases |
| Random call drop | Disconnected?handleCallEnded | main.js + LiveKit leave logs | reconnect-aware leave | Code + deploy yes | Real network blips still drop media until rejoin |
| Auto audio flaky | Empty room / concurrent Chrome / capacity | egress Start signal not received; FEATURE flag | keep audio independent of call end | Partial | Needs live participants E2E |
| Dental start/stop flaky | No camera track; capacity | 409 without camera (correct); track SID errors in smoke | reject without camera | Yes for guard | Concurrent with audio on 2 vCPU |
| Media finalize errors | Egress abort / empty room | EG_* aborted logs | materialize path pre-exists | Partial | Capacity/finalize races |
| VPS constrained | 2 vCPU shared SFU+Egress+DB | nproc=2; dual egress mem/CPU; prior no response | stopped publisher; report resize | Documented | Need bigger/isolated egress |


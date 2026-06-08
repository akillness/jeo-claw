# jeo-claw

이중 런타임(**ZeroClaw** · **NullClaw**) 에이전틱 PR 오케스트레이션. 로컬 Docker 우선, **Discord**로 제어, 대상 저장소는 `akillness/jeo-claw` 자체. 두 런타임을 동일 LLM(OpenAI gpt-5) 설정으로 공존시켜 **상시 A/B 비교**한다.

> 설계 근거: `.gjc/specs/deep-interview-jeo-claw-docker-security.md` + `.gjc/plans/ralplan/2026-06-08-0954-05fb/pending-approval.md`.

## 아키텍처 한눈에

```
사용자 ──Discord──▶ discord-bot ──typed event──▶ glue-webhook ──▶ [ZeroClaw role services] ┐
                          │  action-scoped 승인 게이트        [NullClaw role services] ┘ ──▶ GitHub PR
                          ▼                                                              │
                    Discord 승인/상태/대시보드 ◀──────── compare(A/B 메트릭) ◀──────────┘
```

역할 파이프라인(각 런타임별 5개 Docker role service): 리서치+코드작성 → 코드리뷰 → PR 생성(push 포함, Discord 승인) → PR 리뷰 검수 스케줄링 → CI 통과 시 머지검토+머지(Discord 승인).

## 보안 자세 (2026 claw 보안 기준)

- 어떤 서비스에도 **호스트 Docker 소켓을 마운트하지 않는다.**
- claw 런타임은 `internal: true` 네트워크에만 연결 → 인터넷 직접 경로 없음. 모든 egress는 **allowlist 프록시**(GitHub/OpenAI/gcloud Secret/Discord)만 통과.
- 모든 장기 서비스 `restart: unless-stopped` (자동 재시작).
- `cap_drop: ALL` + `no-new-privileges` + 읽기전용 루트FS(+tmpfs).
- autonomy=**supervised**, 머지·push 등 고위험은 **Discord 승인 필수**(glue에서 강제).
- PR 생성(`pr.create`/`git.push`)과 머지(`git.merge`/`pr.merge`)는 workflow 단위가 아니라 **action-scoped single-use approval**로 승인된다.
- 비밀은 **gcloud Secret Manager**에서 역할별 최소권한으로 주입. 평문 토큰은 이미지/리포에 두지 않는다.
- Discord/webhook control plane은 `discord-bot` + `glue-webhook`으로 분리되며 `claw_internal`에만 붙고, `egress-proxy`만 `edge` 네트워크를 가진다.

## 디렉터리 레이아웃

| 경로 | 내용 | 스토리 |
|------|------|--------|
| `docker-compose.yml` | 10개 runtime-role service + split control plane + egress-proxy + 네트워크 | G001/G002 |
| `runtimes/{zeroclaw,nullclaw}/Dockerfile` | 업스트림 빌드 이미지 | G001 |
| `control/Dockerfile` | `glue-webhook` / `discord-bot` control service 이미지 | G002 |
| `compose/egress-proxy/` | squid 설정 + allowlist | G001 |
| `config/` | 런타임 config(toml/json) | G002 |
| `secrets/` | gcloud Secret 로더 | G003 |
| `glue/` | 웹훅 수신 + 단계 상태머신 + 머지 게이트 | G004 |
| `discord/` | Discord 제어 봇 | G005 |
| `compare/` | A/B 러너 + 대시보드 | G006 |
| `scripts/` | 정적 검증 스크립트 | G001 |

## 부트스트랩

```bash
# 1) 의존성
bun install

# 2) 환경 변수 (실제 비밀은 절대 커밋 금지 — gcloud Secret Manager에서 주입)
cp .env.example .env   # 비-비밀 ID/설정만 채움

# 3) 정적 보안 검증 (docker 불필요)
bun run check:compose
bun test

# 4) 기동 (Docker 환경에서)
docker compose up -d --build
docker compose ps          # egress-proxy/glue-webhook/discord-bot + 10개 runtime-role service healthy 확인
```

## 사용 가이드

### 1. 검증 / 정적 게이트 (Docker 불필요)

오케스트레이션 글루는 Bun+TypeScript이며, 실제 컨테이너 없이도 아래 4개 게이트로 동작을 검증한다.

```bash
bunx tsc --noEmit            # 타입 체크 (strict; noEmit)
bun test                     # 전체 단위/통합/레드팀 테스트
bun run check:compose        # docker-compose 정적 보안 검사
bun run config/validate.ts   # A/B 공정성 + 런타임 config 검사
```

마지막 검증 기준(green): `tsc` 0 errors · `bun test` 84 pass / 0 fail · `check:compose` 172/172 · `config validate` 18/18.

### 2. 로컬에서 글루 서버 띄우기

```bash
GITHUB_WEBHOOK_SECRET=dev-secret bun run glue   # glue/server.ts, 기본 :8787
```

HTTP 서피스(`glue/server.ts`):

| 메서드 · 경로 | 용도 | 응답 |
|------|------|------|
| `GET /health` | 헬스체크 | `200 {ok:true}` |
| `POST /control-event` | Discord 제어 이벤트 주입(`ControlEvent` JSON) | request→`201`, approve/reject→`200`/`404`, config-set→`202` |
| `POST /webhook/github` | GitHub 웹훅 수신 | HMAC 서명(`x-hub-signature-256`) 필수, 위조 시 `401` |
| `POST /dispatch` | 런타임 디스패치 | 설계상 미구현 → `501` (컨트롤 플레인은 명령 실행 안 함) |

웹훅은 `?workflowId=` 쿼리 → 바디 `workflowId/id` → `prNumber` 순으로 워크플로우를 매칭한다. 매칭 실패 시 `202`(no-op).

빠른 확인 예:

```bash
# 새 워크플로우 시작
curl -s -XPOST localhost:8787/control-event \
  -H 'content-type: application/json' \
  -d '{"type":"request","runtime":"zeroclaw","request":"fix flaky test"}'
# → {"success":true,"workflow":{"id":"wf-...","stage":"research-code","status":"running",...}}
```

### 3. Discord 제어 명령어

봇은 `discord/commands.ts`의 `parseCommand`로 슬래시(`/cmd`)·평문 양쪽을 파싱한다. 고위험 액션은 **workflow id + action**을 모두 명시해야 승인된다.

| 명령 | 의미 |
|------|------|
| `request <zeroclaw\|nullclaw> <요청>` | 해당 런타임으로 새 워크플로우 시작 |
| `approve <workflowId> <action>` | 고위험 액션 단건 승인 (action-scoped, single-use) |
| `reject <workflowId> <action>` | 고위험 액션 거부 |
| `config set <provider\|model\|autonomy\|scaleout> <value>` | 런타임 설정 변경 |

- `<action>` 허용값: `pr.create`, `git.push`, `git.merge`, `pr.merge`.
- `config set` 제약: `autonomy`는 `supervised`만, `scaleout`은 정수 1–3, `provider`/`model`은 비어 있을 수 없음.

### 4. 워크플로우 라이프사이클

```
research-code → review → pr-create → pr-review-schedule → merge
```

- 각 stage는 5개 역할(`researcher-coder` … `merger`)에 1:1 매핑되고, 실제 작업은 각 런타임 내장 SOP/subagent가 수행한다.
- **PR 생성**(`pr.create`/`git.push`)과 **머지**(`git.merge`/`pr.merge`)는 진행 전 Discord 승인이 필요하며, 승인은 1회용으로 소비된다.
- **머지 게이트**(`glue/merge-gate.ts`)는 `ciPassed && reviewPassed && discordApproved`가 **모두 boolean `true`**일 때만 main 머지를 허용한다(엄격 비교 — truthy 우회 차단). 하나라도 빠지면 차단 사유를 반환한다.

### 5. A/B 비교 러너

동일 E2E 시나리오를 두 런타임에서 N회(`COMPARE_RUNS`, 기본 5) 반복하고 6개 지표를 집계한다.

```bash
bun run compare   # compare/runner.ts
```

수집 지표(`MetricSample`→`RuntimeMetricSummary`): `latencyMs`(응답시간) · `ramMb`/`cpuPct`(자원) · `ciPassRate`(품질) · `tokenCost`(비용) · `failureRate`(안정성). 결과는 `compare/dashboard.ts`가 Discord 임베드로 렌더한다.

## 라이브 실행에 필요한 사용자 자격증명

다음은 사용자가 gcloud Secret Manager에 등록해야 하며(역할별 최소권한), 코드/이미지에 평문으로 두지 않는다:
`OPENAI_API_KEY`, `DISCORD_BOT_TOKEN`, `GITHUB_TOKEN`(PR생성/머지 인스턴스만 쓰기), `GITHUB_WEBHOOK_SECRET`.

## 상태

현재 승인된 ralplan 기반 ultragoal(G001~G004)을 실행 중이며, 진행/검수 이력은 `.gjc/ultragoal/ledger.jsonl`.

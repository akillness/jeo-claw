<!-- Parent: AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# jeo-claw 배포·실행 가이드 (막힌 지점 우회 포함)

이 문서는 **컨테이너 빌드 → 실행 → 풀스택 라이브 구동**을 다루고, 환경별로 막히는 지점과
그 해결책(특히 **gcloud 없이** 구동하는 file 시크릿 모드)을 정리한다. 모든 명령은 `jeo-claw/`에서 실행.

> 보안 불가침(CONSTITUTION I): 평문 비밀은 리포/이미지/로그/문서에 절대 두지 않는다.
> file 시크릿 모드를 쓰면 JSON 파일은 **반드시 gitignore**(`secrets/*.json`은 이미 무시됨)하고 컨테이너엔 read-only로만 마운트한다.

---

## 0. 사전 준비

```bash
cd jeo-claw
bun install
cp .env.example .env        # 비-비밀 ID/설정만 채움 (GCLOUD_PROJECT, DISCORD_*_ID 등)
```

검증 게이트(Docker 불필요)로 코드 건전성부터 확인:

```bash
bunx tsc --noEmit            # 0 errors
bun test                     # 전체 통과
bun run check:compose        # docker-compose 정적 보안 176/176
bun run config/validate.ts   # A/B 공정성 16/16
```

---

## 1. 컨테이너 빌드

```bash
# 전체 (control 2 + 런타임 10 + egress-proxy)
docker compose --env-file .env build

# 개별
docker compose --env-file .env build glue-webhook
docker compose --env-file .env build zeroclaw-researcher-coder
docker compose --env-file .env build nullclaw-researcher-coder
```

빌드 시 가져오는 업스트림(검증됨):
- **ZeroClaw**: `zeroclaw-labs/zeroclaw` install.sh → prebuilt 바이너리(v0.7.5).
- **NullClaw**: Zig `0.16.0` 다운로드 후 `nullclaw/nullclaw` 소스 `zig build`.
- **control**: 우리 Bun+TS + `google-cloud-cli`.

> ⚠️ 과거 빌드 실패 2건은 수정 완료(이 리포에 반영됨):
> 1. compose의 런타임 `build.context`가 `./runtimes/<rt>`라 repo 루트 COPY가 실패 → `context: .` + `dockerfile: runtimes/<rt>/Dockerfile`로 수정.
> 2. nullclaw의 Zig URL 필드 순서 오류(`zig-linux-x86_64` 404) → 실제 자산 `zig-x86_64-linux`로 수정.

---

## 2. 실행 방법 A — 컨트롤 플레인 단독 (비밀 불필요, 가장 빠른 검증)

glue 서버만 dev 시크릿으로 컨테이너에서 띄운다. (라이브 비밀/런타임 없이 HTTP·보안 게이트 검증용)

```bash
docker run -d --name jeo-glue -p 127.0.0.1:18787:8787 \
  -e GLUE_PORT=8787 \
  -e GITHUB_WEBHOOK_SECRET=dev-secret \
  -e JEO_CONTROL_EVENT_SECRET=dev-control-secret \
  -e GCLOUD_PROJECT=dev -e GCLOUD_SECRET_PREFIX=jeo-claw \
  -e TARGET_REPO=akillness/jeo-claw -e TARGET_BRANCH=main \
  -e JEO_RUNTIME_DISPATCH_SECRET=rds \
  jeo-claw-glue-webhook:latest bun run glue/server.ts

curl -s localhost:18787/health        # → {"ok":true}
docker logs -f jeo-glue
docker rm -f jeo-glue                  # 중지/제거
```

기대 동작(검증됨): `/health`→200, 시크릿 없는 `/control-event`·`/dispatch`→401, 위조 HMAC `/webhook/github`→401, 금지 필드 `/dispatch`→`400 forbidden dispatch field`.

---

## 3. 막힌 지점: 풀스택 라이브 구동 — 비밀 주입

`docker compose up`으로 전체 스택을 돌리려면 **6개 비밀 + 1개 dispatch 비밀**이 필요하다.
비밀은 두 가지 소스 중 하나로 주입한다 — 코드가 `secretSourceFromEnv`로 둘 다 지원한다.

필요한 비밀(이름은 `<GCLOUD_SECRET_PREFIX>-<name>` 형식, 기본 prefix `jeo-claw`):

| 시크릿 이름 | 용도 |
|-------------|------|
| `jeo-claw-openai-codex-oauth` | 양 런타임 ChatGPT OAuth(Codex `auth.json`) |
| `jeo-claw-github-token-ro` | 읽기 전용 GitHub |
| `jeo-claw-github-token-rw` | 승인된 write(PR 생성/머지)용 |
| `jeo-claw-github-webhook-secret` | 웹훅 HMAC |
| `jeo-claw-discord-bot-token` | Discord 봇 |
| `jeo-claw-control-event-secret` | 내부 control-event 인증 |
| `jeo-claw-runtime-dispatch-secret` | glue→런타임 dispatch 인증 |

> 공유 비밀(`github-webhook-secret`, `control-event-secret`, `runtime-dispatch-secret`)은 **24자 이상**이어야 한다(loader가 강제).

### 3-A. 옵션 1 — gcloud Secret Manager (운영 권장)

전제: `gcloud` 설치 + 프로젝트 IAM 권한.

```bash
gcloud auth login
gcloud config set project <YOUR_GCP_PROJECT>
gcloud services enable secretmanager.googleapis.com

# 비밀 생성 (값은 stdin으로만 — 셸 히스토리 노출 최소화)
printf '%s' "<CODEX_AUTH_JSON>"  | gcloud secrets create jeo-claw-openai-codex-oauth  --data-file=-
printf '%s' "<GH_TOKEN_RO>"       | gcloud secrets create jeo-claw-github-token-ro       --data-file=-
printf '%s' "<GH_TOKEN_RW>"       | gcloud secrets create jeo-claw-github-token-rw       --data-file=-
printf '%s' "<WEBHOOK_SECRET_24+>"| gcloud secrets create jeo-claw-github-webhook-secret --data-file=-
printf '%s' "<DISCORD_TOKEN>"     | gcloud secrets create jeo-claw-discord-bot-token     --data-file=-
printf '%s' "<CONTROL_SECRET_24+>"| gcloud secrets create jeo-claw-control-event-secret  --data-file=-
printf '%s' "<DISPATCH_SECRET_24+>"| gcloud secrets create jeo-claw-runtime-dispatch-secret --data-file=-
```

`.env`: `GCLOUD_PROJECT`=실제 프로젝트 ID, `GCLOUD_SECRET_PREFIX`=jeo-claw, `DISCORD_*_ID` 채움.
(컨테이너 내부에서 gcloud ADC가 필요하면 워크로드 ID 또는 서비스계정 키 마운트를 사용 — 키 파일도 절대 커밋 금지.)

### 3-B. 옵션 2 — file 시크릿 모드 (**gcloud 없이 구동** — 막힌 지점의 해결책)

`gcloud`가 없거나 로컬에서 빠르게 돌릴 때. 코드가 `JEO_SECRET_SOURCE=file`을 지원한다.

```bash
# 1) gitignore되는 경로에 JSON 작성 (secrets/*.json 은 .gitignore에 이미 포함)
cat > secrets/live.json <<'JSON'
{
  "jeo-claw-openai-codex-oauth": "<CODEX_AUTH_JSON>",
  "jeo-claw-github-token-ro": "<GH_TOKEN_RO>",
  "jeo-claw-github-token-rw": "<GH_TOKEN_RW>",
  "jeo-claw-github-webhook-secret": "<24자 이상>",
  "jeo-claw-discord-bot-token": "<DISCORD_TOKEN>",
  "jeo-claw-control-event-secret": "<24자 이상>",
  "jeo-claw-runtime-dispatch-secret": "<24자 이상>"
}
JSON
chmod 600 secrets/live.json
```

로컬 `bun run`(Docker 없이)으로 control 서비스를 file 비밀로:

```bash
GCLOUD_PROJECT=local GCLOUD_SECRET_PREFIX=jeo-claw \
TARGET_REPO=akillness/jeo-claw TARGET_BRANCH=main \
JEO_SECRET_SOURCE=file JEO_SECRETS_FILE="$PWD/secrets/live.json" \
bun run control/start.ts glue-webhook
```

> `control/start.ts`·`runtimes/start.ts`·`glue/server.ts` 모두 `secretSourceFromEnv`로 file 모드를 인식해, 위 비밀(webhook/control/dispatch 포함)을 JSON에서 읽는다. 직접 env로 `*_SECRET`을 넣을 필요가 없다.

Docker 단일 컨테이너로 file 모드:

```bash
docker run -d --name jeo-glue -p 127.0.0.1:18787:8787 \
  -e GCLOUD_PROJECT=local -e GCLOUD_SECRET_PREFIX=jeo-claw \
  -e TARGET_REPO=akillness/jeo-claw -e TARGET_BRANCH=main \
  -e JEO_SECRET_SOURCE=file -e JEO_SECRETS_FILE=/run/secrets/live.json \
  -v "$PWD/secrets/live.json:/run/secrets/live.json:ro" \
  jeo-claw-glue-webhook:latest bun run control/start.ts glue-webhook
```

> compose 풀스택을 file 모드로 돌리려면 각 서비스에 동일 마운트 + `JEO_SECRET_SOURCE/JEO_SECRETS_FILE`를
> `docker-compose.override.yml`로 주입한다(아래 4-B). 단, read-only 루트FS이므로 `/run/secrets`(tmpfs) 아래로만 마운트.

---

## 4. 풀스택 기동

### 4-A. gcloud 모드
```bash
docker compose --env-file .env up -d --build
docker compose --env-file .env ps          # 13개 서비스 healthy 확인
docker compose --env-file .env logs -f glue-webhook
docker compose --env-file .env down
```

### 4-B. file 모드 override (gcloud 없이 풀스택)
`docker-compose.override.yml` 생성:
```yaml
services:
  glue-webhook:
    environment:
      JEO_SECRET_SOURCE: file
      JEO_SECRETS_FILE: /run/secrets/live.json
    volumes:
      - ./secrets/live.json:/run/secrets/live.json:ro
  discord-bot:
    environment:
      JEO_SECRET_SOURCE: file
      JEO_SECRETS_FILE: /run/secrets/live.json
    volumes:
      - ./secrets/live.json:/run/secrets/live.json:ro
  # 런타임 10개에도 동일 environment + volumes 반복 (YAML 앵커로 묶어도 됨)
```
```bash
docker compose --env-file .env up -d --build
```

---

## 5. preflight — 기동 전 라이브 준비 점검

`docker compose up` 전에 비밀·환경이 갖춰졌는지 검증한다(gcloud/file 모드 모두 지원).

```bash
# gcloud 모드
GCLOUD_PROJECT=<proj> GCLOUD_SECRET_PREFIX=jeo-claw \
TARGET_REPO=akillness/jeo-claw TARGET_BRANCH=main \
bun run scripts/preflight-live.ts

# file 모드
JEO_SECRET_SOURCE=file JEO_SECRETS_FILE="$PWD/secrets/live.json" \
GCLOUD_PROJECT=local GCLOUD_SECRET_PREFIX=jeo-claw \
TARGET_REPO=akillness/jeo-claw TARGET_BRANCH=main \
bun run scripts/preflight-live.ts
```

E2E 글루 스모크(승인→브로커→write 경로를 mock으로 검증):
```bash
bun run scripts/smoke-glue.ts
```

---

## 6. 동작 흐름 (기동 후)

1. Discord에서 `request zeroclaw "<작업>"` → `glue-webhook`이 워크플로우 생성.
2. dispatchable stage(research-code·review·pr-review-schedule)는 런타임 role service가 수행.
3. `pr.create`/`pr.merge`는 **Discord action-scoped 승인** 후 `glue-webhook`이 brokered RW 토큰으로 실행.
4. 머지 게이트: `ciPassed && reviewPassed && discordApproved`가 모두 `=== true`일 때만 허용.
5. A/B 대시보드는 `compare/`가 Discord 임베드로 보고.

---

## 7. 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `bind: ...forbidden by access permissions` (Windows) | 호스트 포트(8787) 점유/예약 | 다른 호스트 포트로 매핑: `-p 127.0.0.1:18787:8787` |
| 런타임 컨테이너가 `cannot load jeo-claw-openai-codex-oauth`로 종료 | 비밀 미주입 | gcloud 등록 또는 file 모드(§3) |
| `MissingSecretError: JEO_SECRETS_FILE is required` | file 모드인데 경로 미지정 | `JEO_SECRETS_FILE` 설정 |
| `shared secret too short` | 공유 비밀 24자 미만 | webhook/control/dispatch 비밀을 24자 이상으로 |
| 런타임 빌드 `COPY ... not found` | 옛 build.context | 이미 수정됨(`context: .`); 옛 캐시면 `--no-cache` 재빌드 |
| nullclaw Zig 404 | 옛 Zig URL | 이미 수정됨(`zig-x86_64-linux-<ver>`) |
| `docker compose ps`에 unhealthy | egress-proxy 미기동/allowlist | `docker compose logs egress-proxy`, allowlist 확인 |

---

## 8. 현재 환경(이 워크스테이션) 상태 요약

- ✅ Docker Desktop 동작 → 3개 이미지(control/zeroclaw/nullclaw) **빌드 성공**.
- ✅ 방법 A(컨트롤 플레인 단독) **컨테이너 구동·검증 완료**.
- ❌ 방법 B 풀스택: `gcloud` 미설치 → **옵션 2(file 모드)** 또는 gcloud 설치 환경 필요.
- 다음 한 걸음: `secrets/live.json` 작성 → `bun run scripts/preflight-live.ts`(file 모드)로 green 확인 → `docker compose up`(4-B override).

## 9. 자동 업데이트 (Auto-Update Listener)

호스트에서 GitHub Push Webhook을 수신하여 자동으로 `git pull` 및 `docker compose up -d --build`를 실행하는 리스너를 제공한다.

```bash
# 호스트 환경에서 실행 (Docker 내부 아님)
GITHUB_WEBHOOK_SECRET="<웹훅_시크릿>" TARGET_BRANCH="main" bun run update-listener
```

- 기본 포트는 `8788`이며, `UPDATE_LISTENER_PORT` 환경 변수로 변경할 수 있다.
- GitHub 저장소 설정에서 Webhook을 추가하고, Payload URL을 `http://<호스트_IP>:8788`로 설정한다.
- Content type은 `application/json`으로 설정하고, Secret은 `GITHUB_WEBHOOK_SECRET`과 동일하게 설정한다.
- 이 스크립트는 호스트의 Docker 데몬에 접근해야 하므로 컨테이너 외부에서 실행해야 한다.

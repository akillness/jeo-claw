<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# scripts — 운영 실행 스크립트

## Purpose
WORKFLOW 단계를 실행하는 Bun+TS 스크립트. jeo-claw strict TS 규약을 그대로 따른다.

## Key Files
| File | Description |
|------|-------------|
| `capture-knowledge.ts` | 9-CAPTURE: 완료 작업을 vault(raw/wiki/log/index)에 적재 |
| `capture-knowledge.test.ts` | 적재 로직 단위 테스트(주입식 in-memory FS) |

## 사용
```bash
bun run ops/scripts/capture-knowledge.ts \
  --title "<작업 제목>" \
  --slug "<slug>" \
  --summary "<무엇을·왜·결과>" \
  --tags "domain,security,glue" \
  --runtime both \
  --evidence "artifacts/verify-transcript.txt"
```

## For AI Agents
### Working In This Directory
- 순수 빌더(`buildArtifacts`)와 효과 함수(`applyCapture`)를 분리, FS는 `CaptureFs`로 주입.
- 정책은 결과 객체(`CaptureResult {ok, written, skipped, reasons}`)로 반환, 예외 남발 금지.
- `raw/`·`wiki/`는 write-if-absent(불변/LLM소유 보존), `log.md`는 append.

### Testing Requirements
- `bunx tsc --noEmit` (strict, 루트 tsconfig) · `bun test ops/scripts/`.

<!-- MANUAL: -->

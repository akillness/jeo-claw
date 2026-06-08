# Adversarial Red-Team QA Report: jeo-claw Orchestration

## Status: PASSED

The adversarial red-team suite was regenerated after implementing the action-scoped approval model, strict boolean parsing, role/control secret separation, and control-pivot rejection surface. No blockers were found in the current run.

---

## Final Test Run Results

* **Command:** `bun test qa/red-team.test.ts`
* **Pass count:** 19 pass
* **Fail count:** 0 fail
* **Execution Transcript:** `artifacts/red-team-transcript.txt`
* **Generated:** 2026-06-08T13:37:24.599145+00:00

---

## QA Matrix

| Target Contract | Surface | Adversarial Case | Verdict | Artifact Ref |
|---|---|---|---|---|
| **Merge gate policy** | Algorithm | All 2-of-3 combinations (ci+review, ci+approve, review+approve) are blocked. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Merge gate policy** | Algorithm | Truthy-but-not-true values (`"yes"`, `1`, `{}`) are blocked. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Webhook signature verification** | Package / API | Tampered body with a valid old signature header is rejected. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Webhook signature verification** | Package / API | Signature verified with a wrong secret is rejected. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Webhook signature verification** | Package / API | Malformed headers and length mismatch are rejected without throwing. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Least-privilege secrets** | Package | Read-only roles never trigger access to the write-scoped token ID. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Least-privilege secrets** | Package | Missing required secret or empty value throws `MissingSecretError`. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Secret redaction** | Algorithm | `redact()` masks regex-special values and thrown errors do not contain loaded secret values. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **High-risk guard** | Package | High-risk actions are blocked without matching action approval. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **High-risk guard** | Package | Action-scoped approval is consumed after one use. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **High-risk guard** | Package | Approval for workflow/action A does not authorize workflow/action B. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Command parser robustness** | Algorithm | Malformed/empty/unrecognized inputs return `unknown` and do not crash. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Command parser robustness** | Algorithm | Commands with extra whitespace parse correctly, including `approve wf-123 pr.create`. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Metric math** | Algorithm | Empty samples and single-runtime inputs resolve gracefully. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |
| **Metric math** | Algorithm | All-failed and mixed batches produce exact CI/failure-rate math. | **PASSED** | `qa/red-team.test.ts`, `artifacts/red-team-transcript.txt` |

---

## Notes

Docker-daemon runtime compromise probes are represented in this no-Docker environment by static Compose checks plus unit/integration negative tests for action approval, secret access, webhook forgery, and control dispatch schemas. The operational Docker smoke tests remain part of the execution acceptance bundle for environments with a Docker daemon.

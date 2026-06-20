const secret = "c4d5d2f7071751a543514a894acd70bfb3a538b234175edb5cec6278bfc2494c";
const body = JSON.stringify({
  type: "request",
  source: "discord",
  runtime: "zeroclaw",
  repo: "akillness/jeo-claw",
  request: "이전에 진행하던 메모리 누수 최적화(인메모리 Map을 bun:sqlite로 전환하는 작업)를 다시 진행해. 코드가 방대해도 타임아웃 제한이 해제되었으니 끝까지 완수해서 깃허브 PR까지 올리고 가재촌 채널에 승인 버튼을 발생시켜라."
});

fetch("http://127.0.0.1:8787/control-event", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-control-event-secret": secret
  },
  body
}).then(async r => {
  console.log(r.status, await r.text());
}).catch(console.error);

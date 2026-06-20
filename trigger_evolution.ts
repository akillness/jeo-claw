const secret = "c4d5d2f7071751a543514a894acd70bfb3a538b234175edb5cec6278bfc2494c";
const body = JSON.stringify({
  type: "request",
  source: "discord",
  runtime: "zeroclaw",
  repo: "akillness/jeo-claw",
  request: "1. 디스코드 승인 요청 알림(Approve 버튼)이 불필요한 단계에서 울리지 않고, '실제로 승인이 필요한 시점(awaiting-approval 상태 및 pendingAction 존재 시)'에만 정확히 발송되도록 glue/server.ts 및 discord/bot.ts의 notifyStatus 로직을 개선하라. \n2. 매 사이클마다 병합(merge)되지 않고 남아있는 PR이 있는지 확인하여 처리하는 '자동 머지 확인 단계(Auto-Merge Check)'를 파이프라인(Ouroboros 루프 또는 별도 워커)에 추가하라."
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

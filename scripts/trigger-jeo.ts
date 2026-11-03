async function run() {
    const secret = process.env.JEO_CONTROL_EVENT_SECRET;
    if (!secret) throw new Error("JEO_CONTROL_EVENT_SECRET is required");
    const res = await fetch("http://127.0.0.1:8787/control-event", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-control-event-secret": secret
        },
        body: JSON.stringify({
            type: "request",
            runtime: "zeroclaw",
            request: "디스코드 승인 요청 팝업 중복 발송 버그 수정. glue/server.ts 및 discord/bot.ts 리팩토링. (jeo-code 에이전트 검증용)"
        })
    });
    console.log(await res.text());
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

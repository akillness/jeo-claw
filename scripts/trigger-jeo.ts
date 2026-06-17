async function run() {
    const res = await fetch("http://127.0.0.1:8787/control-event", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-control-event-secret": "c4d5d2f7071751a543514a894acd70bfb3a538b234175edb5cec6278bfc2494c"
        },
        body: JSON.stringify({
            type: "request",
            runtime: "zeroclaw",
            request: "디스코드 승인 요청 팝업 중복 발송 버그 수정. glue/server.ts 및 discord/bot.ts 리팩토링. (jeo-code 에이전트 검증용)"
        })
    });
    console.log(await res.text());
}
run().catch(console.error);

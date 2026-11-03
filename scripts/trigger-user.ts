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
            request: "https://github.com/akillness/jeo-claw 프로젝트의 에이전트 성능평가를 통해 성능 개선방법을 논의하고 개선방향적용해보면서 성능이 개선된 코드로 발전시켜나가고 정교하고 빠르게, 메모리누수없는 성능 최적화를 병행하는게 중요해. 즉 스스로 진화하면서 발전되도록해야해. 현재 제로클로의 도커 프로젝트 시스템인데 업데이트되면 도커 재빌드를통해 바로 적용되도록 작업해"
        })
    });
    console.log(await res.text());
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

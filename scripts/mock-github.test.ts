import { test, expect } from "bun:test";

test("mock github service supports PR create, list, and merge", async () => {
  const pulls = new Map<number, any>();
  let nextNumber = 400;
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const create = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    const merge = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
    if (req.method === "GET" && create) {
      const head = url.searchParams.get("head") ?? "";
      const base = url.searchParams.get("base") ?? "";
      const items = [...pulls.values()].filter((pull) => !pull.merged && (!head || pull.head === head) && (!base || pull.base === base));
      return new Response(JSON.stringify(items), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && create) {
      const body = await req.json() as { title: string; head: string; base: string };
      const pull = { number: nextNumber++, head: body.head, base: body.base, title: body.title, html_url: `https://mock/${body.head}`, merged: false };
      pulls.set(pull.number, pull);
      return new Response(JSON.stringify(pull), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "PUT" && merge) {
      const number = Number(merge[3]);
      const pull = pulls.get(number);
      pull.merged = true;
      return new Response(JSON.stringify({ merged: true, sha: `mocksha${number}` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  };

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  try {
    let res = await fetch(`${server.url.origin}/repos/acme/repo/pulls?state=open&head=acme:branch&base=main`);
    expect(await res.json()).toEqual([]);

    res = await fetch(`${server.url.origin}/repos/acme/repo/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "PR", head: "acme:branch", base: "main" }),
    });
    const created = await res.json() as { number: number };
    expect(created.number).toBe(400);

    res = await fetch(`${server.url.origin}/repos/acme/repo/pulls?state=open&head=acme:branch&base=main`);
    const listed = await res.json() as Array<{ number: number }>;
    expect(listed.map((pull) => pull.number)).toEqual([400]);

    res = await fetch(`${server.url.origin}/repos/acme/repo/pulls/400/merge`, { method: "PUT" });
    expect((await res.json() as { sha: string }).sha).toBe("mocksha400");
  } finally {
    server.stop(true);
  }
});

interface PullRequestRecord {
  number: number;
  head: string;
  base: string;
  title: string;
  body?: string;
  html_url: string;
  merged: boolean;
}

const port = Number(process.env.MOCK_GITHUB_PORT ?? 8788);
let nextNumber = Number(process.env.MOCK_GITHUB_PR_START ?? 314);
const pulls = new Map<number, PullRequestRecord>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathMatch(pathname: string): { owner: string; repo: string; number?: number } | undefined {
  const create = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
  if (create) return { owner: create[1]!, repo: create[2]! };
  const merge = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
  if (merge) return { owner: merge[1]!, repo: merge[2]!, number: Number(merge[3]) };
  return undefined;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return json(200, { ok: true, pulls: pulls.size });
  }

  if (req.method === "GET" && url.pathname === "/debug/pulls") {
    return json(200, [...pulls.values()]);
  }

  const match = pathMatch(url.pathname);
  if (!match) return json(404, { message: `Unknown mock path: ${url.pathname}` });

  if (req.method === "GET") {
    const head = url.searchParams.get("head") ?? "";
    const base = url.searchParams.get("base") ?? "";
    const items = [...pulls.values()].filter((pull) => !pull.merged && (!head || pull.head === head) && (!base || pull.base === base));
    return json(200, items);
  }

  if (req.method === "POST") {
    const body = (await req.json()) as { title: string; body?: string; head: string; base: string };
    const existing = [...pulls.values()].find((pull) => !pull.merged && pull.head === body.head && pull.base === body.base);
    if (existing) return json(200, existing);

    const number = nextNumber++;
    const pull: PullRequestRecord = {
      number,
      head: body.head,
      base: body.base,
      title: body.title,
      body: body.body,
      html_url: `https://mock.github.local/${match.owner}/${match.repo}/pull/${number}`,
      merged: false,
    };
    pulls.set(number, pull);
    return json(201, pull);
  }

  if (req.method === "PUT" && match.number !== undefined) {
    const pull = pulls.get(match.number);
    if (!pull) return json(404, { message: `Pull ${match.number} not found` });
    pull.merged = true;
    return json(200, { merged: true, sha: `mocksha${match.number}` });
  }

  return json(405, { message: `Method not allowed: ${req.method}` });
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch: handle,
});

console.log(`[mock-github] listening on ${server.url.origin}`);

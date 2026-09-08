/**
 * In-process node:http fake Langfuse server (03 layout) that replays committed
 * fixture pages under tests/fixtures/langfuse-http/<scenario>/ and can inject
 * 429/5xx/delay/redirect behaviours per route. Tests never touch the network.
 *
 * Routes served (Langfuse v4 public API, read-only):
 *   GET {base}/projects            → projects.json
 *   GET {base}/v2/observations     → cursor-keyed page replay (below)
 *   GET {base}/v3/scores           → cursor-keyed page replay (below)
 *
 * Cursor semantics (Langfuse [DEC-03]): the page whose meta.cursor is token T
 * is followed by the page the CLIENT requests with cursor=T. The server builds
 * that chain from the committed pages: no cursor → first page; cursor T →
 * the page AFTER the one that emitted T; unknown cursor → 404. This makes a
 * replayed walk deterministic AND lets an interrupted ingest resume from page
 * one (review N9: the server now notices cursor-blind clients).
 *
 * Window semantics (acceptance SHOULD-3): the sync engine ALWAYS sends window
 * params — fromStartTime/toStartTime on v2 observations, fromTimestamp/
 * toTimestamp on v3 scores. When they are present the server behaves like a
 * real Langfuse read API: each page's rows are filtered to [from, to) and the
 * cursor chain ENDS once the remaining pages hold nothing in-window (Langfuse
 * stops serving pages past the window bound), so a windowed walk can never
 * ingest out-of-window rows and terminates like the real server would. Without
 * window params the legacy full-chain replay is kept verbatim.
 *
 * Behaviours are applied before the replay, consume their `times` budget on
 * matching requests and may be delayed (after N route requests) and gated on
 * the page `limit` query param (--small-pages halving tests).
 */

import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FakeRoute = 'projects' | 'observations' | 'scores';

export interface FakeBehavior {
  route: FakeRoute;
  /** how many consecutive matching requests get this behaviour (default 1). */
  times?: number;
  /** only fire after this many requests to the same route (default 0). */
  after?: number;
  /** only fire when the request's limit query param is above this number. */
  whenLimitAbove?: number;
  status: number;
  headers?: Record<string, string>;
  /** delay the response (ms) before writing the status — timeout tests. */
  delayMs?: number;
  body?: string;
}

export interface FakeRequest {
  route: FakeRoute;
  method: string;
  pathname: string;
  query: Record<string, string[]>;
  authorization: string | null;
  at: number; // epoch ms when the request arrived
}

export interface FakeServerHandle {
  /** origin only, e.g. http://127.0.0.1:4318 */
  url: string;
  /** origin + /api/public — pass this as LangfuseSourceOptions.baseUrl */
  baseUrl: string;
  requests(): readonly FakeRequest[];
  close(): Promise<void>;
}

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'langfuse-http');

function routeOf(pathname: string): FakeRoute | null {
  if (pathname.endsWith('/projects')) return 'projects';
  if (pathname.endsWith('/v2/observations')) return 'observations';
  if (pathname.endsWith('/v3/scores')) return 'scores';
  return null;
}

export async function startFakeLangfuseServer(opts?: {
  scenario?: string;
  behaviors?: FakeBehavior[];
}): Promise<FakeServerHandle> {
  const scenario = opts?.scenario ?? 'refunds';
  const scenarioDir = join(FIXTURES_ROOT, scenario);
  const log: FakeRequest[] = [];
  const budgets = (opts?.behaviors ?? []).map((b) => ({ ...b, remaining: b.times ?? 1 }));
  const routeSeen = new Map<FakeRoute, number>();
  // cached replay chain per route: sorted page files + content + cursor map
  const chainCache = new Map<FakeRoute, RouteChain>();

  interface ChainPage {
    file: string;
    body: string;
    /** meta.cursor of THIS page (null when it is the final page). */
    cursor: string | null;
    /** parsed data rows (newest → oldest in committed file order). */
    rows: Array<Record<string, unknown>>;
  }

  interface RouteChain {
    first: { file: string; body: string };
    byCursor: Map<string, { file: string; body: string }>;
    pages: ChainPage[];
  }

  const server: Server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function loadChain(route: FakeRoute): Promise<RouteChain | undefined> {
    const cached = chainCache.get(route);
    if (cached !== undefined) return cached;
    let files: string[];
    try {
      files = (await readdir(join(scenarioDir, route, 'pages')))
        .filter((n) => n.endsWith('.json'))
        .sort();
    } catch {
      chainCache.set(route, undefined as never);
      return undefined;
    }
    const pages: ChainPage[] = [];
    for (const file of files) {
      const body = await readFile(join(scenarioDir, route, 'pages', file), 'utf8');
      let parsed: { data?: unknown; meta?: { cursor?: unknown } } | null = null;
      try {
        parsed = JSON.parse(body) as { data?: unknown; meta?: { cursor?: unknown } };
      } catch {
        parsed = null;
      }
      let cursor: string | null = null;
      if (parsed !== null) {
        cursor = typeof parsed.meta?.cursor === 'string' ? parsed.meta.cursor : null;
      }
      const rows: Array<Record<string, unknown>> = [];
      if (parsed !== null && Array.isArray(parsed.data)) {
        for (const item of parsed.data) {
          if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            rows.push(item as Record<string, unknown>);
          }
        }
      }
      pages.push({ file, body, cursor, rows });
    }
    const byCursor = new Map<string, { file: string; body: string }>();
    for (let i = 0; i < pages.length - 1; i += 1) {
      const page = pages[i]!;
      const next = pages[i + 1]!;
      if (page.cursor !== null) byCursor.set(page.cursor, { file: next.file, body: next.body });
    }
    const chain: RouteChain = {
      first: { file: pages[0]!.file, body: pages[0]!.body },
      byCursor,
      pages,
    };
    chainCache.set(route, chain);
    return chain;
  }

  /** Langfuse window params per route; undefined ⇒ no window filter. */
  function windowOf(
    route: FakeRoute,
    query: Record<string, string[]>,
  ): { from: string; to: string } | undefined {
    if (route === 'projects') return undefined;
    const fromKey = route === 'observations' ? 'fromStartTime' : 'fromTimestamp';
    const toKey = route === 'observations' ? 'toStartTime' : 'toTimestamp';
    const from = query[fromKey]?.[0];
    const to = query[toKey]?.[0];
    return from !== undefined && to !== undefined ? { from, to } : undefined;
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = routeOf(url.pathname);
    if (route === null) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams.entries()) {
      (query[k] ??= []).push(v);
    }
    log.push({
      route,
      method: req.method ?? 'GET',
      pathname: url.pathname,
      query,
      authorization: req.headers.authorization ?? null,
      at: Date.now(),
    });
    const routeCount = routeSeen.get(route) ?? 0;
    routeSeen.set(route, routeCount + 1);

    const limitRaw = query.limit?.[0];
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);

    const behaviour = budgets.find(
      (b) =>
        b.route === route &&
        b.remaining > 0 &&
        (b.after ?? 0) <= routeCount &&
        (b.whenLimitAbove === undefined || (limit !== undefined && limit > b.whenLimitAbove)),
    );
    if (behaviour !== undefined) {
      behaviour.remaining -= 1;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...behaviour.headers,
      };
      const write = () => {
        try {
          res.writeHead(behaviour.status, headers);
          res.end(behaviour.body ?? '');
        } catch {
          // client aborted/closed before the delayed response was written
        }
      };
      if (behaviour.delayMs !== undefined) setTimeout(write, behaviour.delayMs);
      else write();
      return;
    }

    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };

    if (route === 'projects') {
      try {
        const body = await readFile(join(scenarioDir, 'projects.json'), 'utf8');
        send(200, body);
      } catch {
        send(404, '{"error":"no projects fixture"}');
      }
      return;
    }

    // observations / scores: cursor-keyed replay of the committed page chain.
    // When the request carries window params the rows are filtered to the
    // window and the chain ends once no later page holds in-window rows
    // (Langfuse window semantics — see header note).
    const chain = await loadChain(route);
    if (chain === undefined) {
      send(404, `{"error":"no ${route} fixture pages"}`);
      return;
    }
    const win = windowOf(route, query);
    const cursorParam = query.cursor?.[0];

    // page index for this request: no cursor → newest page; cursor T → the
    // page after the one that emitted T; unknown cursor → 404 (unchanged).
    let pageIndex: number;
    if (cursorParam === undefined || cursorParam === '') {
      pageIndex = 0;
    } else {
      const emitter = chain.pages.findIndex((p) => p.cursor === cursorParam);
      if (emitter === -1 || emitter === chain.pages.length - 1) {
        send(404, `{"error":"unknown cursor ${cursorParam}"}`);
        return;
      }
      pageIndex = emitter + 1;
    }

    if (win === undefined) {
      // legacy blind replay (tests hitting the routes without a window)
      const page = chain.pages[pageIndex]!;
      if (pageIndex === 0) send(200, chain.first.body);
      else send(200, page.body);
      return;
    }

    const timeOf = (row: Record<string, unknown>): unknown =>
      route === 'observations' ? row.startTime : row.timestamp;
    const inWindow = (row: Record<string, unknown>): boolean => {
      const t = timeOf(row);
      // [DEC-08] window convention: from inclusive, to exclusive
      return typeof t === 'string' && win.from <= t && t < win.to;
    };
    const page = chain.pages[pageIndex]!;
    const data = page.rows.filter(inWindow);
    // End the cursor chain when the next page cannot hold in-window rows
    // (every remaining row is older than the window's `from`) — mirroring
    // Langfuse's bounded scan. Rows newer than `to` on leading pages keep the
    // chain alive (empty pages with a cursor), like a real paged walk.
    let cursor: string | null = page.cursor;
    if (cursor !== null) {
      const next = chain.pages[pageIndex + 1];
      const nextHoldsWindowRows =
        next !== undefined &&
        next.rows.some((row) => {
          const t = timeOf(row);
          return typeof t === 'string' && t >= win.from;
        });
      if (!nextHoldsWindowRows) cursor = null;
    }
    send(200, JSON.stringify({ data, meta: { cursor } }));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    get url() {
      return `http://127.0.0.1:${address.port}`;
    },
    get baseUrl() {
      return `http://127.0.0.1:${address.port}/api/public`;
    },
    requests() {
      return log;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

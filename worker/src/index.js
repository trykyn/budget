// 가계부 서버 (Cloudflare Worker, 무료 요금제)
//
// 1) 기록 보관: 휴대폰을 바꿔도, 여러 기기에서 열어도 같은 가계부가 보이게.
//      GET  /d/{키}   → { tx, stocks, cats, bal, ico }
//      POST /d/{키}   { tx?: {id: 기록|null}, stocks?: {id: 종목|null}, cats?: {kr,de}, bal?: {kr,de}, ico?: {항목: 아이콘|null}, rules?: {상대방: 규칙|null}, restore? }
//                     보낸 항목만 바꿈 (null = 지움). 다른 기기에서 넣은 기록은 건드리지 않음.
//    키는 앱이 처음 열릴 때 만든 32자리 무작위 문자열. 키를 아는 사람만 읽고 쓸 수 있음.
//    저장소 (KV): STORE — data:{키} → 위 JSON 하나
//
// 2) 주식 시세 (브라우저에서는 시세 사이트에 바로 못 물어봐서 여기서 대신 물어봄)
//      GET /q?s=005930.KS,EUNL.DE,USDEUR=X   → { 기호: { p, prev, chg, cur, name, t, closes } }  (1개월 종가)
//      GET /c?s=기호&r=3mo|1y|5y              → { closes, ts, cur }  (자세히 보기 그래프)
//      GET /s?q=삼성 | 애플 | TIGER 미국     → [{ sym, name, ex, type }]  (네이버 먼저, 없으면 야후)
//    시세는 야후 파이낸스 (거래소에 따라 15~20분 늦을 수 있음). 1분 동안 같은 답을 재사용.

const ALLOWED_ORIGINS = ["https://trykyn.github.io", "http://localhost:8775", "http://localhost:8790"];
const KEY_RE = /^[A-Za-z0-9]{24,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYM_RE = /^[A-Za-z0-9.^=_-]{1,24}$/;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200, cache = "no-store") =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const [, kind, key] = url.pathname.split("/");

    try {
      if (kind === "q" && request.method === "GET") {
        const syms = [...new Set((url.searchParams.get("s") || "").split(",").map(s => s.trim()).filter(s => SYM_RE.test(s)))].slice(0, 40);
        const out = {};
        await Promise.all(syms.map(async s => { out[s] = await quote(s, ctx).catch(() => null); }));
        return json(out, 200, "public, max-age=30");
      }
      if (kind === "c" && request.method === "GET") {
        const s = url.searchParams.get("s") || "";
        const r = ({ "1mo": "1mo", "3mo": "3mo", "1y": "1y", "5y": "5y" })[url.searchParams.get("r")] || "3mo";
        if (!SYM_RE.test(s)) return json({ error: "bad_symbol" }, 400);
        const iv = r === "5y" ? "1wk" : "1d";
        const c = await yahooChart(s, r, iv, ctx, 600);
        if (!c) return json({ error: "not_found" }, 404);
        return json({ closes: c.closes, ts: c.ts, cur: c.cur }, 200, "public, max-age=300");
      }
      if (kind === "s" && request.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim().slice(0, 40);
        if (!q) return json([]);
        return json(await search(q), 200, "public, max-age=600");
      }
    } catch (e) {
      return json({ error: "upstream", detail: String(e).slice(0, 200) }, 502);
    }

    if (kind !== "d" || !KEY_RE.test(key || "")) return json({ error: "not_found" }, 404);
    const sk = `data:${key}`;
    const load = async () => ({ tx: {}, stocks: {}, cats: {}, bal: {}, ico: {}, rules: {}, ...((await env.STORE.get(sk, "json")) || {}) });

    if (request.method === "GET") return json(await load());

    if (request.method === "POST") {
      const text = await request.text();
      if (text.length > 3_000_000) return json({ error: "too_big" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
      let data = await load();
      const before = JSON.stringify(data);
      const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

      // 백업 파일로 되살리기: 기록 전체를 바꿈
      if (body.restore && typeof body.restore === "object") {
        const r = body.restore;
        data = { tx: {}, stocks: {}, cats: {}, bal: {}, ico: {}, rules: {} };
        for (const [id, v] of Object.entries(obj(r.tx))) { const t = cleanTx(v); if (ID_RE.test(id) && t) data.tx[id] = t; }
        for (const [id, v] of Object.entries(obj(r.stocks))) { const t = cleanStock(v); if (ID_RE.test(id) && t) data.stocks[id] = t; }
        data.cats = cleanCats(obj(r.cats), {});
        data.bal = cleanBal(obj(r.bal), {});
        data.ico = cleanIco(obj(r.ico), {});
        data.rules = cleanRules(obj(r.rules), {});
      }
      for (const [id, v] of Object.entries(obj(body.tx)).slice(0, 2000)) {
        if (!ID_RE.test(id)) continue;
        const t = v && cleanTx(v);
        if (t) data.tx[id] = t; else delete data.tx[id];
      }
      for (const [id, v] of Object.entries(obj(body.stocks)).slice(0, 200)) {
        if (!ID_RE.test(id)) continue;
        const t = v && cleanStock(v);
        if (t) data.stocks[id] = t; else delete data.stocks[id];
      }
      if (body.cats) data.cats = cleanCats(obj(body.cats), data.cats);
      if (body.bal) data.bal = cleanBal(obj(body.bal), data.bal);
      if (body.ico) data.ico = cleanIco(obj(body.ico), data.ico || {});
      if (body.rules) data.rules = cleanRules(obj(body.rules), data.rules || {});

      // 바뀐 게 없으면 저장하지 않음 (무료 요금제 하루 저장 횟수 아끼기)
      if (JSON.stringify(data) !== before) await env.STORE.put(sk, JSON.stringify(data));
      return json(data);
    }
    return json({ error: "method" }, 405);
  },
};

// ── 기록 정리 (이상한 값은 버림) ──
const num = v => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const str = (v, n) => (v == null || v === "" ? undefined : String(v).slice(0, n));
const round2 = n => Math.round(n * 100) / 100;

// 기록 하나: acc 'kr'|'de', type 'out'(지출) | 'in'(수입·입금) | 'xfer'(독일 → 한국 송금, 두 계좌에 모두 보임)
function cleanTx(v) {
  if (!v || typeof v !== "object") return null;
  const date = DATE_RE.test(v.date || "") ? v.date : null;
  if (!date) return null;
  const u = num(v.u) || Date.now();
  if (v.type === "xfer") {
    const eur = num(v.eur), krw = num(v.krw);
    if (eur == null || krw == null || eur <= 0 || krw <= 0) return null;
    const fee = num(v.fee);
    return { type: "xfer", date, eur: round2(eur), krw: Math.round(krw), fee: fee && fee > 0 ? round2(fee) : undefined, memo: str(v.memo, 200), est: v.est ? true : undefined, src: str(v.src, 64), u };
  }
  if (!["kr", "de"].includes(v.acc) || !["in", "out"].includes(v.type)) return null;
  const amount = num(v.amount);
  if (amount == null || amount <= 0 || amount > 1e12) return null;
  return { acc: v.acc, type: v.type, date, amount: v.acc === "kr" ? Math.round(amount) : round2(amount), cat: str(v.cat, 40), memo: str(v.memo, 200), src: str(v.src, 64), u };
}

// 종목 하나: acc 'kr'|'de' (어느 증권 계좌), sym 야후 기호, qty 주 수, avg 평균 매수가(그 종목 통화)
function cleanStock(v) {
  if (!v || typeof v !== "object" || !["kr", "de"].includes(v.acc) || !SYM_RE.test(v.sym || "")) return null;
  const qty = num(v.qty), avg = num(v.avg);
  if (qty == null || qty < 0) return null;
  return { acc: v.acc, sym: v.sym, name: str(v.name, 80), cur: str(v.cur, 6), qty: Math.round(qty * 1e6) / 1e6, avg: avg != null && avg > 0 ? avg : undefined, u: num(v.u) || Date.now() };
}

function cleanCats(c, old) {
  const out = { ...old };
  for (const acc of ["kr", "de"]) {
    if (!Array.isArray(c[acc])) continue;
    out[acc] = [...new Set(c[acc].map(x => String(x || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 40);
  }
  return out;
}

// 항목 아이콘: { 항목 이름: 아이콘 이름 | null } (null = 지움 → 앱이 이름으로 짐작)
function cleanIco(b, old) {
  const out = { ...old };
  for (const [k, v] of Object.entries(b).slice(0, 200)) {
    const name = String(k).trim().slice(0, 40);
    if (!name) continue;
    if (typeof v === "string" && /^[a-z]{2,12}$/.test(v)) out[name] = v; else delete out[name];
  }
  return Object.fromEntries(Object.entries(out).slice(-200));
}

// 가져오기에서 배운 것: { 상대방 키: "cat:항목" | "in" | "xfer" | "skip" | null }
function cleanRules(b, old) {
  const out = { ...old };
  for (const [k, v] of Object.entries(b).slice(0, 1000)) {
    const name = String(k).trim().slice(0, 40);
    if (!name) continue;
    if (typeof v === "string" && /^(cat:.{1,40}|in|xfer|skip)$/.test(v)) out[name] = v; else delete out[name];
  }
  return Object.fromEntries(Object.entries(out).slice(-1000));
}

// 기준 잔액: { kr: { amount, date } } → 그 날짜까지의 통장 잔액. 이후 기록으로 지금 잔액을 계산
function cleanBal(b, old) {
  const out = { ...old };
  for (const acc of ["kr", "de"]) {
    if (!(acc in b)) continue;
    const v = b[acc], a = v && num(v.amount);
    if (v && a != null && DATE_RE.test(v.date || "")) out[acc] = { amount: a, date: v.date }; else delete out[acc];
  }
  return out;
}

// ── 시세 ──
async function cachedFetch(u, ctx, ttl) {
  const cache = caches.default;
  const req = new Request(u);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  const body = await r.text();
  ctx.waitUntil(cache.put(req, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })));
  return JSON.parse(body);
}

async function yahooChart(sym, range, interval, ctx, ttl) {
  const j = await cachedFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`, ctx, ttl);
  const r = j?.chart?.result?.[0];
  if (!r) return null;
  const raw = r.indicators?.quote?.[0]?.close || [];
  const ts = [], closes = [];
  (r.timestamp || []).forEach((t, i) => { if (raw[i] != null) { ts.push(t); closes.push(Math.round(raw[i] * 10000) / 10000); } });
  return { meta: r.meta || {}, ts, closes, cur: r.meta?.currency };
}

async function quote(sym, ctx) {
  const c = await yahooChart(sym, "1mo", "1d", ctx, 60);
  if (!c) return null;
  const m = c.meta;
  const p = m.regularMarketPrice ?? c.closes.at(-1);
  if (p == null) return null;
  // 오늘 등락: 야후가 주는 값 우선, 없으면 종가로 계산
  let prev = m.fulldayChange != null ? p - m.fulldayChange : m.previousClose;
  if (prev == null) {
    const today = c.ts.length && Math.abs(c.ts.at(-1) - (m.regularMarketTime || 0)) < 86400 ? 2 : 1;
    prev = c.closes.at(-today);
  }
  const chg = m.regularMarketChangePercent ?? (prev ? (p / prev - 1) * 100 : null);
  // 마지막 종가를 지금 값으로 맞춰서 작은 그래프 끝이 지금 값이 되게
  const closes = c.closes.slice();
  if (closes.length && Math.abs((c.ts.at(-1) || 0) - (m.regularMarketTime || 0)) < 86400) closes[closes.length - 1] = p; else closes.push(p);
  return { p, prev, chg, cur: m.currency, name: m.longName || m.shortName || sym, t: m.regularMarketTime, closes: closes.slice(-30) };
}

async function search(q) {
  const out = [];
  // 네이버 먼저: 한글 이름(삼성전자, 애플, TIGER 미국S&P500)·종목 코드 모두. 한국(코스피 .KS / 코스닥 .KQ)과 미국 종목만
  try {
    const r = await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`, { headers: { "User-Agent": UA } });
    const j = await r.json();
    for (const it of (j.items || []).slice(0, 12)) {
      if (it.nationCode === "KOR" && /^\w{6}$/.test(it.code || "")) {
        const suf = it.typeCode === "KOSDAQ" ? ".KQ" : it.typeCode === "KOSPI" ? ".KS" : null;
        if (suf) out.push({ sym: it.code + suf, name: it.name, ex: it.typeName || it.typeCode, type: "EQUITY" });
      } else if (it.nationCode === "USA" && /^[A-Z.]{1,8}$/.test(it.code || "")) {
        out.push({ sym: it.code.replace(".", "-"), name: it.name, ex: it.typeCode, type: "EQUITY" });
      }
    }
  } catch {}
  // 네이버에 없으면 야후 (영문 이름, ISIN 등)
  if (!out.length && !/[가-힣]/.test(q)) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`, { headers: { "User-Agent": UA } });
      const j = await r.json();
      for (const it of j.quotes || []) {
        if (!it.symbol || !["EQUITY", "ETF", "MUTUALFUND", "INDEX", "CRYPTOCURRENCY"].includes(it.quoteType)) continue;
        out.push({ sym: it.symbol, name: (it.longname || it.shortname || it.symbol).trim(), ex: it.exchDisp || it.exchange, type: it.quoteType });
      }
    } catch {}
  }
  return out;
}

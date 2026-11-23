// N26 거래 내역 가져오기 (CSV · PDF). 파일은 휴대폰 안에서만 읽고, 어디로도 보내지 않음.
//
//   N26.parseCsv(text)          → [거래]
//   N26.parsePdfLines(pages)    → [거래]   pages = [[줄, 줄, …], …]  (pdf.js 글자를 줄로 모은 것)
//   N26.suggest(거래, ctx)       → 거래마다 { type: out|in|xfer|skip, key: 아이콘 이름|null, memo }
//
// 거래 = { date: 'YYYY-MM-DD', amount: 부호 있는 EUR, partner, iban: bool, kind: card|debit|transfer|refund, ref, n26cat, internal }
// internal = 내 Space(비상금, 반올림 저축 등)로 옮긴 돈 → 지출이 아니라서 기본으로 빼 둠
// 항목 제안은 '아이콘 이름'(basket, food, tram …)으로 하고, 앱이 사용자의 항목 중 그 아이콘인 것을 찾아 씀
// (항목 이름을 바꿔도 맞게). 사람 이름이나 개인 정보는 여기에 넣지 않음 — 사용자가 고친 건 앱 데이터(rules)에 저장.
(function (g) {
  // ── CSV ──
  function csvRows(s) {
    // 구분 기호는 첫 줄(제목 줄)을 보고 정함: 쉼표 CSV 안의 ';' 는 글자로 둠
    const head = s.split(/\r?\n/, 1)[0] || '';
    const delim = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim()));
  }
  const num = s => { s = String(s || '').trim(); if (!s) return NaN; if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); return parseFloat(s.replace(/[^\d.+-]/g, '')); };
  const isoDate = s => { s = String(s || '').trim(); let m = s.match(/^(\d{4})-(\d\d)-(\d\d)/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = s.match(/^(\d\d)\.(\d\d)\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

  function parseCsv(text) {
    const rows = csvRows(String(text).replace(/^﻿/, ''));
    if (rows.length < 2) return [];
    const h = rows[0].map(x => x.trim().toLowerCase());
    const col = (...names) => { for (const n of names) { const i = h.indexOf(n.toLowerCase()); if (i >= 0) return i; } return -1; };
    const C = {
      date: col('Booking Date', 'Datum', 'Buchungsdatum'), partner: col('Partner Name', 'Empfänger', 'Payee'),
      iban: col('Partner Iban', 'Kontonummer', 'Account number'), type: col('Type', 'Transaktionstyp', 'Transaction type'),
      ref: col('Payment Reference', 'Verwendungszweck', 'Payment reference'), amount: col('Amount (EUR)', 'Betrag (EUR)', 'Amount (EUR)'),
      cat: col('Kategorie', 'Category'), account: col('Account Name'),
    };
    if (C.date < 0 || C.amount < 0) throw new Error('N26 CSV 가 아니에요 (날짜·금액 칸을 못 찾음)');
    const main = C.account >= 0 ? (rows.slice(1).map(r => r[C.account]).find(Boolean) || '') : '';
    const out = [];
    for (const r of rows.slice(1)) {
      const date = isoDate(r[C.date]), amount = num(r[C.amount]);
      if (!date || !isFinite(amount) || !amount) continue;
      if (C.account >= 0 && main && r[C.account] && r[C.account] !== main && /space/i.test(r[C.account])) continue; // Space 쪽 줄
      const type = (r[C.type] || '').trim(), iban = !!(r[C.iban] || '').trim();
      const kind = /refund/i.test(type) ? 'refund' : /presentment|mastercard|card/i.test(type) ? 'card' : /direct debit|lastschrift/i.test(type) ? 'debit' : 'transfer';
      out.push({ date, amount, partner: (r[C.partner] || '').trim(), iban, kind, ref: (r[C.ref] || '').trim(), n26cat: C.cat >= 0 ? (r[C.cat] || '').trim() : '',
        internal: kind === 'transfer' && !iban });
    }
    return out;
  }

  // ── PDF (N26 'Kontoaktivität' / Kontoauszug) ──
  // 한 쪽: 위 머리말(이름·주소·IBAN …) → "Beschreibung Verbuchungsdatum Betrag" → 거래들 → "Kontoaktivität" 꼬리말
  // 거래 하나: 상대방 / "Mastercard • 분류" 또는 "Lastschriften|Gutschriften|Belastungen|…" / (IBAN 줄) / (참고 줄) / Wertstellung 날짜 / 날짜 금액€
  const AMT_RE = /(\d\d\.\d\d\.\d{4})\s+([+-−]?\s?[\d.]+,\d\d)\s*€?\s*$/;
  const KIND_LINE = /^(Lastschriften|Gutschriften|Belastungen|Überweisungen|Ueberweisungen|Gutschrift|Lastschrift|Dauerauftr[aä]ge?|Erstattungen?)\b/i;
  function parsePdfLines(pages) {
    const out = [];
    for (const lines0 of pages) {
      const start = lines0.findIndex(l => /Beschreibung\s+Verbuchungsdatum\s+Betrag/i.test(l));
      if (start < 0) continue;
      let end = lines0.findIndex((l, i) => i > start && /^(Kontoaktivit|Kontoauszug|Anmerkung)/i.test(l.trim()));
      if (end < 0) end = lines0.length;
      let blk = [];
      for (const raw of lines0.slice(start + 1, end)) {
        const l = raw.replace(/\s+/g, ' ').trim();
        if (!l) continue;
        const m = l.match(AMT_RE);
        if (!m) { blk.push(l); continue; }
        const before = l.slice(0, m.index).trim();
        if (before && !/^Wertstellung/i.test(before)) blk.push(before);
        const rec = { date: isoDate(m[1]), amount: num(m[2].replace(/[−\s]/g, s => s === '−' ? '-' : '')), partner: '', iban: false, kind: 'transfer', ref: '', n26cat: '', internal: false };
        const rest = [];
        blk.forEach((b, i) => {
          if (/^Wertstellung/i.test(b)) return;
          if (/^IBAN:/i.test(b)) { rec.iban = true; return; }
          const mc = b.match(/^Mastercard\s*[•·�-]?\s*(.*)$/i);
          if (mc) { rec.kind = 'card'; rec.n26cat = mc[1].trim(); return; }
          if (KIND_LINE.test(b)) { rec.kind = /lastschrift/i.test(b) ? 'debit' : /erstattung/i.test(b) ? 'refund' : 'transfer'; return; }
          if (i === 0) { rec.partner = b; return; }
          rest.push(b);
        });
        // "An" / "Von" (+ Space 이름) 에 IBAN 이 없으면 내 Space 로 옮긴 것
        const anVon = rec.partner.match(/^(An|Von)\b\s*(.*)$/);
        if (anVon && !rec.iban) { rec.internal = true; rec.partner = anVon[2] || 'Space'; }
        rec.ref = rest.join(' ');
        if (rec.date && isFinite(rec.amount) && rec.amount) out.push(rec);
        blk = [];
      }
    }
    return out;
  }

  // pdf.js 글자 조각 { x, y, s, w } → parsePdfLines 가 읽는 줄 목록 (한 쪽).
  // N26 PDF 는 날짜·금액이 오른쪽 칸에서 상대방 이름과 같은 높이에 있음 → 위치로 묶음:
  // 오른쪽 '날짜 금액' 줄 하나 = 거래 하나, 그 높이부터 다음 거래 바로 위까지 왼쪽 줄들이 설명
  function pdfItemsToLines(items) {
    const hd = items.find(i => /^Beschreibung/.test(i.s.trim()));
    if (!hd) return [];
    const vb = items.find(i => /Verbuchungsdatum/.test(i.s));
    const splitX = vb ? vb.x - 15 : 300;
    const body = items.filter(i => i.y < hd.y - 3);
    const group = arr => {
      const rows = [];
      for (const it of arr.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
        let r = rows.find(r => Math.abs(r.y - it.y) < 2.5);
        if (!r) rows.push(r = { y: it.y, items: [] });
        r.items.push(it);
      }
      return rows.map(r => {
        r.items.sort((a, b) => a.x - b.x);
        let s = '', end = null;
        for (const it of r.items) { if (end != null && it.x - end > 1.5) s += ' '; s += it.s; end = it.x + (it.w || 0); }
        return { y: r.y, s: s.replace(/\s+/g, ' ').trim() };
      });
    };
    const FOOT = /^(Kontoaktivit|Kontoauszug|Anmerkung)|^\d\d\.\d\d\.\d{4} bis \d\d\.\d\d\.\d{4}$|^\d+ ?\/ ?\d+$/;
    const left = group(body.filter(i => i.x < splitX)).filter(l => l.s && !FOOT.test(l.s));
    const anchors = group(body.filter(i => i.x >= splitX)).filter(l => /^\d\d\.\d\d\.\d{4}\s*[+\-−]?\s?[\d.]+,\d\d/.test(l.s)).sort((a, b) => b.y - a.y);
    const out = ['Beschreibung Verbuchungsdatum Betrag'];
    anchors.forEach((a, k) => {
      const lower = k + 1 < anchors.length ? anchors[k + 1].y + 8 : -Infinity;
      // 설명은 위에서부터 "Wertstellung" 줄까지 (그 아래는 쪽 꼬리말: 이름·주소·IBAN)
      for (const l of left) if (l.y <= a.y + 8 && l.y > lower) { out.push(l.s); if (/^Wertstellung/i.test(l.s)) break; }
      out.push(a.s);
    });
    out.push('Kontoaktivität');
    return out;
  }

  // ── 같은 곳 알아보기 ──
  function partnerKey(p) {
    return String(p || '').toLowerCase()
      .replace(/^(paypal|sumup|zettle_?|uzr|spc|mol|sp)\s*\*\s*/, '')
      .split(/\s+/).filter(t => t && !/\d/.test(t)).join(' ')
      .replace(/[^\p{L}\p{N}.&' -]/gu, '').trim().slice(0, 40);
  }
  const displayName = p => String(p || '').replace(/^(paypal|sumup|zettle_?|uzr|spc)\s*\*\s*/i, '').replace(/\s+/g, ' ').trim();

  // ── 항목 제안 (아이콘 이름) ──
  const RULES = [
    ['tram', /deutsche bahn|db vertrieb|\bdb\b|\bmvg\b|\bmvv\b|handyticket|handyparken|easypark|parkhaus|parkgarage|parkster|parken|parking|pasmo|suica|sixt|europcar|tankstelle|\baral\b|\bshell\b|\besso\b|\bjet\b|total service|\bomv\b|\buber\b(?! ?eats)|\bbolt\b|taxi|flixbus|mr wash|car ?wash|\badac\b|deutschlandticket/i],
    ['basket', /knuspr|\brewe\b|edeka|\baldi\b(?! talk)|\blidl\b|\bnetto\b|\bpenny\b|kaufland|\bhit\b|\bspar\b|asia ?markt|halal|supermarkt|denns|alnatura|bio company|rossmann|dm[- ]?drogerie|\bnorma\b|tegut|globus|lebensmittel/i],
    ['food', /restaurant|ristorante|trattoria|pizz|sushi|kebab|d[öo]ner|imbiss|bistro|mcdonald|burger|\bkfc\b|subway|lieferando|\bwolt\b|uber ?eats|starbucks|\bcaf[eé]\b|coffee|kaffee|konditorei|b[äa]e?cke|backhau|backstub|bakery|gastro|gelato|malatang|maltang|hansik|ramen|noodle/i],
    ['kid', /schule|\bkita\b|kindergarten|kinder|\bbaby|legoland|junior|spielwaren|\btoys?\b|jako-o|smyths|mytoys|\bhort\b/i],
    ['lotus', /wellpass|egym|urban ?sports|fitness|\bgym\b|mcfit|john reed|sauna|therme|\bspa\b|massage|yoga|pilates|wellness|kosmetik|beauty|laser|nagelstudio|\bnails?\b|friseur|barber/i],
    ['suitcase', /booking\.com|hotel|airbnb|expedia|check24.*reise|\breise|airport|airline|lufthansa|ryanair|easyjet|eurowings|condor|emirates|travel|resort|hostel|ferienwohnung/i],
    ['bag', /amazon|amzn|zalando|h&m|hm\.com|\bh_m\b|uniqlo|\bmango\b|\bzara\b|primark|c&a|tchibo|westwing|ikea|douglas|rituals|est[eé]e ?lauder|sephora|thule|\botto\b|about you|limango|galeria|decathlon|tk ?maxx|media ?markt|saturn|kleinanzeigen|vinted/i],
    ['phone', /telekom|vodafone|\bo2\b|telefonica|1&1|congstar|fraenk|aldi talk|\bvpn|netflix|spotify|disney\+?|apple\.com|icloud|youtube|audible/i],
    ['shield', /versicherung|allianz|\bhuk\b|\bergo\b|\baxa\b|debeka|generali|lebensvers|haftpflicht|krankenkasse|\baok\b|barmer/i],
    ['home', /stadtwerke|\bswm\b|strom|\bgas\b|miete|hausverwaltung|rundfunk|beitragsservice|nebenkosten|vattenfall|e\.on/i],
    ['medical', /apotheke|\barzt|dr\.? ?med|praxis|klinik|zahn|physio|optik/i],
  ];
  const N26CAT = [
    [/lebensmittel/i, 'basket'], [/bars|restaurant|essen/i, 'food'], [/transport|auto/i, 'tram'], [/shopping/i, 'bag'], [/kinder/i, 'kid'],
    [/medien|telekom/i, 'phone'], [/versicherung/i, 'shield'], [/wohnen|energie|haushalt/i, 'home'], [/reise|urlaub/i, 'suitcase'], [/gesundheit|drogerie/i, 'medical'],
  ];
  const XFER_RE = /remitly|wise\.com|\bwise\b|transferwise|western union|moneygram|worldremit|azimo/i;
  const SALARY_RE = /staatsoberkasse|bez[üu]ge|gehalt|\blohn\b|salary/i;
  const KINDERGELD_RE = /familienkasse|kindergeld/i;

  // 사용자가 고친 것: rules { '상대방 키|-': 'cat:항목' | 'xfer' | 'skip' | 'pass', '상대방 키|+': 'in' | 'skip' | 'pass' | 'cat:항목'(환불) }
  // 예전 규칙(부호 없는 키)은 그 부호에 맞는 값일 때만 씀
  const ruleKey = (key, amount) => `${key}|${amount < 0 ? '-' : '+'}`;
  function findRule(rules, key, amount) {
    if (!rules || !key) return null;
    const signed = rules[ruleKey(key, amount)];
    if (signed) return signed;
    const old = rules[key];
    if (!old) return null;
    if (amount < 0) return /^(cat:|xfer$|skip$|pass$)/.test(old) ? old : null;
    return /^(in|skip|pass)$/.test(old) ? old : null;
  }
  // 나간 돈 아이콘 짐작 (가게 이름 → N26 분류 순서)
  function guessKey(r) {
    const text = `${r.partner} ${r.ref}`;
    for (const [ico, re] of RULES) if (re.test(text)) return ico;
    if (r.n26cat) for (const [re, ico] of N26CAT) if (re.test(r.n26cat)) return ico;
    return null;
  }

  // 결과 type: out(지출) | in(수입) | refund(환불: 그 항목 지출에서 뺌) | xfer(한국 송금) | pass(그냥 지나가는 돈) | skip
  function suggest(r, ctx = {}) {
    const key = partnerKey(r.partner), text = `${r.partner} ${r.ref}`;
    const name = displayName(r.partner);
    const base = { memo: name, pkey: key, rkey: key ? ruleKey(key, r.amount) : '' };
    const rule = findRule(ctx.rules, key, r.amount);
    if (r.internal && !rule) return { ...base, type: 'skip', why: 'internal' };
    if (rule) {
      if (rule === 'skip') return { ...base, type: 'skip', why: 'rule' };
      if (rule === 'pass') return { ...base, type: 'pass' };
      if (rule === 'xfer') return { ...base, type: 'xfer' };
      if (rule === 'in') return { ...base, type: 'in' };
      if (rule.startsWith('cat:')) return r.amount < 0 ? { ...base, type: 'out', cat: rule.slice(4) } : { ...base, type: 'refund', cat: rule.slice(4), memo: `환불 · ${name}` };
    }
    if (r.amount < 0 && XFER_RE.test(text)) {
      let m = name.replace(/\*.*$/, '').trim() || name;
      if (m === m.toUpperCase()) m = m.charAt(0) + m.slice(1).toLowerCase(); // REMITLY → Remitly
      return { ...base, type: 'xfer', memo: m };
    }
    if (r.amount > 0) {
      if (r.kind === 'refund') {
        // 그 가게에서 산 것과 같은 항목으로 (산 것에 고른 항목이 있으면 그것)
        const buy = findRule(ctx.rules, key, -1);
        return { ...base, type: 'refund', memo: `환불 · ${name}`, ...(buy && buy.startsWith('cat:') ? { cat: buy.slice(4) } : { key: guessKey(r) }) };
      }
      if (SALARY_RE.test(text)) return { ...base, type: 'in', memo: '월급' };
      // Kindergeld: 받아서 바로 넘겨주는 돈이라 '그냥 지나가는 돈' (넘겨준 거래는 앱이 짝지어 줌)
      if (KINDERGELD_RE.test(text)) return { ...base, type: 'pass', memo: 'Kindergeld' };
      return { ...base, type: 'in' };
    }
    return { ...base, type: 'out', key: guessKey(r) };
  }

  // 그냥 지나가는 돈 짝짓기: '지나감'으로 들어온 돈(예: Kindergeld) 뒤 10일 안에 계좌이체로 나간 돈 중
  // 금액이 그 80~100% 인 첫 거래를 짝으로. rows = [{ r, act }] (날짜순), 바꾼 행 목록을 돌려줌
  function pairPass(rows) {
    const changed = [], used = new Set();
    const day = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
    for (const inc of rows) {
      if (inc.act !== 'pass' || inc.r.amount <= 0) continue;
      const m = rows.find(o => !used.has(o) && o !== inc && o.r.amount < 0 && o.r.kind === 'transfer' && o.r.iban && !o.r.internal && !o.manual && o.act !== 'pass'
        && day(o.r.date) >= day(inc.r.date) && day(o.r.date) - day(inc.r.date) <= 10
        && -o.r.amount <= inc.r.amount + 0.001 && -o.r.amount >= inc.r.amount * 0.8);
      if (m) { used.add(m); m.act = 'pass'; m.pairOf = inc; changed.push(m); }
    }
    return changed;
  }

  // 같은 날 같은 금액이 여러 건이면 순서로 구분 → 'n26:2026-01-01:-5866:0'. CSV 와 PDF 가 같은 값을 만듦 (다시 올려도 안 겹침)
  function withSrc(list) {
    const seen = {};
    return list.map(r => { const b = `${r.date}:${Math.round(r.amount * 100)}`; const k = seen[b] = (seen[b] ?? -1) + 1; return { ...r, src: `n26:${b}:${k}` }; });
  }
  // Remitly 같은 송금: 금액이 3001,99 처럼 수수료 1,99 가 붙어 있으면 나눔
  function splitFee(total) {
    const t = Math.round(Math.abs(total) * 100);
    for (const fee of [199, 299, 399, 99]) if ((t - fee) % 100 === 0 && t - fee > 0 && (t - fee) % 1000 === 0) return { eur: (t - fee) / 100, fee: fee / 100 };
    return { eur: t / 100, fee: 0 };
  }

  g.N26 = { parseCsv, parsePdfLines, pdfItemsToLines, suggest, pairPass, withSrc, splitFee, partnerKey, displayName, ruleKey };
})(typeof window !== 'undefined' ? window : globalThis);

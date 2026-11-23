// N26 가져오기 시험: node budget/tests/n26-test.mjs [CSV 파일]
// 개인 거래 파일은 저장소에 넣지 않음 (budget-private/ 에 둠). 여기서는 숫자만 확인.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
eval(fs.readFileSync(path.join(here, '..', 'import.js'), 'utf8'));
const N26 = globalThis.N26;
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m); } };

// 1) 고정 예시 (가짜 자료)
const csv = `"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"
2026-01-01,2026-01-01,Sparen,,"Debit Transfer",Aufrundung,Hauptkonto,-0.04,,,
2026-01-02,2026-01-02,"REWE Markt",,Presentment,,Hauptkonto,-58.66,58.66,EUR,1
2026-01-03,2026-01-03,"REMITLY* R123",,Presentment,,Hauptkonto,-3001.99,3001.99,EUR,1
2026-01-04,2026-01-04,"Staatsoberkasse Bayern",DE00123,"Credit Transfer","BEZUEGE 2026",Hauptkonto,1409.12,,,
2026-01-05,2026-01-05,"Stadtwerke München GmbH",DE00456,"Direct Debit","MVG HandyTicket Rechnung",Hauptkonto,-18.70,,,
2026-01-05,2026-01-05,"PAYPAL *Shop",,Presentment,,Hauptkonto,-18.70,,,
2026-01-06,2026-01-06,"Uniqlo",,"Presentment Refund",,Hauptkonto,9.95,,,`;
const r = N26.withSrc(N26.parseCsv(csv));
ok(r.length === 7, 'csv rows ' + r.length);
const s = r.map(x => N26.suggest(x, {}));
ok(s[0].type === 'skip', 'space skip');
ok(s[1].type === 'out' && s[1].key === 'basket', 'rewe basket');
ok(s[2].type === 'xfer', 'remitly xfer');
ok(JSON.stringify(N26.splitFee(-3001.99)) === '{"eur":3000,"fee":1.99}', 'fee split');
ok(s[3].type === 'in' && s[3].memo === '월급', 'salary');
ok(s[4].type === 'out' && s[4].key === 'tram', 'mvg tram');
ok(r[4].src !== r[5].src && r[4].src.endsWith(':0') && r[5].src.endsWith(':1'), 'same day same amount → different src');
ok(s[6].type === 'in' && s[6].memo.startsWith('환불'), 'refund');
ok(N26.suggest({ partner: 'EGYM Wellpass GmbH', ref: 'EGYM Wellpass 01-2026', amount: -54.9, kind: 'debit' }).key === 'lotus', 'wellness');
ok(N26.suggest({ partner: 'PAYPAL *Spaeter zahlen', ref: '', amount: -91, kind: 'card' }).key !== 'lotus', 'spaeter is not spa');
ok(N26.suggest(r[1], { rules: { [N26.partnerKey('REWE Markt')]: 'cat:외식' } }).cat === '외식', 'user rule wins');
// PDF 줄 (가짜)
const pages = [['Name', 'Adresse', 'Beschreibung Verbuchungsdatum Betrag',
  'An', 'Aufrundung', 'Wertstellung 01.01.2026', '01.01.2026 -0,04€',
  'Vielen Dank, Knuspr.de', 'Mastercard • Lebensmittel', 'Wertstellung 01.01.2026 01.01.2026 -58,66€',
  'STOK Staatsoberkasse Bayern', 'Gutschriften', 'IBAN: DE00 • BIC: X', 'BEZUEGE F. 1', 'Wertstellung 29.01.2026', '29.01.2026 +1.409,12€',
  'Kontoaktivität', '01.01.2026 bis 23.11.2026']];
const p = N26.parsePdfLines(pages);
ok(p.length === 3, 'pdf rows ' + p.length);
ok(p[0].internal, 'pdf space');
ok(p[1].n26cat === 'Lebensmittel' && p[1].amount === -58.66 && p[1].partner.startsWith('Vielen'), 'pdf card');
ok(p[2].amount === 1409.12 && p[2].iban && !p[2].internal, 'pdf credit');

// 2) 진짜 파일이 있으면 요약만 (budget-private/)
const dir = path.join(here, '..', '..', 'budget-private');
const file = process.argv[2] || (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.csv')).map(f => path.join(dir, f))[0] : null);
if (file) {
  const rows = N26.withSrc(N26.parseCsv(fs.readFileSync(file, 'utf8')));
  const sg = rows.map(x => ({ x, s: N26.suggest(x, {}) }));
  const cnt = {};
  for (const { s } of sg) { const k = s.type === 'out' ? 'out:' + (s.key || '?') : s.type; cnt[k] = (cnt[k] || 0) + 1; }
  console.log('real file rows', rows.length, cnt);
  ok(new Set(rows.map(r => r.src)).size === rows.length, 'src unique');
  if (process.env.SHOW) for (const { x, s } of sg) if (s.type === 'out' && !s.key) console.log('  ?', x.partner, '|', x.ref.slice(0, 30), x.amount);
}
console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);

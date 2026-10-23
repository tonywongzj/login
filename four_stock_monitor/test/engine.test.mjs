import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateAll, evalL1, zoneOf, discountOf } from '../lib/engine.mjs';
import { parseRss, tagItems, matchKeywords } from '../lib/news.mjs';
import { renderMarkdown, renderPush, renderLadderBrief } from '../lib/report.mjs';

const RULES = JSON.parse(readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(RULES);
const quotes = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { price: v, source: 'test' }]));
const BASE = { tencent: 379.8, moutai: 1336.95, popmart: 130.6, hesai: 11.77 };
const types = (r, id) => r.signals.filter((s) => s.stock === id).map((s) => s.type);

test('基准日快照与框架文档一致', () => {
  const r = evaluateAll(RULES, quotes(BASE), '2026-10-23');
  const by = Object.fromEntries(r.stocks.map((s) => [s.id, s]));
  assert.equal(by.tencent.discount.toFixed(3), '0.416');
  assert.equal(by.tencent.zone, '买入区');
  assert.equal(by.moutai.zone, '持有区');
  assert.equal(by.popmart.zone, '持有区');
  assert.equal(by.hesai.zone, '买入区');
  assert.deepEqual(by.tencent.sellLines.map((l) => l.price), [748, 845, 975]);
  assert.deepEqual(by.moutai.sellLines.map((l) => l.price), [2113, 2388, 2756]);
  assert.deepEqual(by.popmart.sellLines.map((l) => l.price), [178, 202, 233]);
  assert.deepEqual(by.hesai.sellLines.map((l) => l.price), [23.3, 26.4, 30.5]);
  assert.equal(Math.round(r.investedCny), 234416);
  // 今日动作：腾讯第一档 + 禾赛半笔；茅台、泡泡玛特不动
  assert.deepEqual(r.signals.filter((s) => s.type === 'BUY').map((s) => s.key), ['tencent:buy:T1', 'hesai:buy:H1a']);
  assert.ok(!types(r, 'moutai').includes('BUY'));
  assert.ok(!types(r, 'popmart').includes('BUY'));
});

test('区间边界', () => {
  const z = RULES.zones;
  assert.equal(zoneOf(-0.01, z), '减仓区');
  assert.equal(zoneOf(0, z), '持有区');
  assert.equal(zoneOf(0.3, z), '观察区');
  assert.equal(zoneOf(0.4, z), '买入区');
  assert.equal(zoneOf(0.5, z), '重仓区');
  assert.equal(discountOf(325, 650), 0.5);
});

test('已成交的档不再提醒', () => {
  const rules = clone();
  rules.stocks[0].buyLadder[0].filled = true;
  const r = evaluateAll(rules, quotes(BASE), '2026-10-23');
  assert.ok(!r.signals.some((s) => s.key === 'tencent:buy:T1'));
});

test('前置条件未满足的档只预警不买', () => {
  const r = evaluateAll(RULES, quotes(BASE), '2026-10-23');
  assert.ok(r.signals.some((s) => s.key === 'hesai:buywait:H1b'));
  const rules = clone();
  rules.stocks[3].buyLadder[1].conditionMet = true;
  const r2 = evaluateAll(rules, quotes(BASE), '2026-10-23');
  assert.ok(r2.signals.some((s) => s.key === 'hesai:buy:H1b'));
});

test('L1 破坏：清仓信号，且压制所有买入信号', () => {
  const rules = clone();
  rules.stocks[3].l1.find((c) => c.id === 'HS-1').value = 34.5;
  const r = evaluateAll(rules, quotes({ ...BASE, hesai: 9 }), '2026-10-23');
  const t = types(r, 'hesai');
  assert.ok(t.includes('L1_BREACH'));
  assert.ok(!t.includes('BUY'));
});

test('L2 减仓只对有持仓的标的推送', () => {
  const r = evaluateAll(RULES, quotes({ ...BASE, moutai: 2200, hesai: 24 }), '2026-10-23');
  assert.ok(!types(r, 'moutai').includes('SELL'));
  assert.deepEqual(r.signals.filter((s) => s.stock === 'hesai' && s.type === 'SELL').map((s) => s.key), ['hesai:sell:0.15']);
});

test('风控线', () => {
  const r = evaluateAll(RULES, quotes({ ...BASE, hesai: 9.8 }), '2026-10-23');
  assert.ok(types(r, 'hesai').includes('RISK'));
});

test('接近买入档预警', () => {
  const r = evaluateAll(RULES, quotes({ ...BASE, moutai: 1200 }), '2026-10-23');
  assert.ok(r.signals.some((s) => s.key === 'moutai:nearbuy:M1'));
});

test('L1 各判定类型', () => {
  assert.equal(evalL1({ kind: 'series', op: '<', threshold: 1369, n: 2, values: [1700, 1300] }, 'x').status, 'warn');
  assert.equal(evalL1({ kind: 'series', op: '<', threshold: 1369, n: 2, values: [1300, 1300] }, 'x').status, 'breach');
  assert.equal(evalL1({ kind: 'series', op: '<', threshold: 0, n: 4, values: [] }, 'x').status, 'pending');
  assert.equal(evalL1({ kind: 'threshold', op: '<', threshold: 35, value: 36, warnPct: 0.05 }, 'x').status, 'warn');
  assert.equal(evalL1({ kind: 'threshold', op: '<', threshold: 35, value: 39.7, warnPct: 0.05 }, 'x').status, 'ok');
  assert.equal(evalL1({ kind: 'deadline', op: '<', threshold: 50, value: 40, deadline: '2027-09-30' }, '2026-12-01').status, 'warn');
  assert.equal(evalL1({ kind: 'deadline', op: '<', threshold: 50, value: 40, deadline: '2027-09-30' }, '2027-10-01').status, 'breach');
  const and = { kind: 'and', parts: [{ label: 'a', op: '>', threshold: 220, value: 230 }, { label: 'b', op: '>', threshold: 30, value: 10 }] };
  assert.equal(evalL1(and, 'x').status, 'warn');
  and.parts[1].value = 35;
  assert.equal(evalL1(and, 'x').status, 'breach');
  assert.equal(evalL1({ kind: 'manual', triggered: true }, 'x').status, 'breach');
});

test('IV 修改必须留痕', () => {
  const rules = clone();
  rules.stocks[2].iv = 140;
  const r = evaluateAll(rules, quotes(BASE), '2026-10-23');
  assert.ok(types(r, 'popmart').includes('IV_AUDIT'));
});

test('行情失败时不判价格信号', () => {
  const q = quotes(BASE);
  delete q.tencent;
  const r = evaluateAll(RULES, q, '2026-10-23');
  assert.deepEqual(types(r, 'tencent'), ['DATA']);
});

test('日程提醒窗口', () => {
  const r = evaluateAll(RULES, quotes(BASE), '2026-11-10');
  assert.ok(r.signals.some((s) => s.type === 'EVENT' && s.stock === 'hesai'));
  const r2 = evaluateAll(RULES, quotes(BASE), '2026-10-23');
  assert.ok(!r2.signals.some((s) => s.type === 'EVENT'));
});

test('无信号时报告明确写「无信号」', () => {
  const rules = clone();
  for (const s of rules.stocks) s.position = { shares: 0, avgCost: 0 };
  const r = evaluateAll(rules, quotes({ tencent: 500, moutai: 1500, popmart: 130, hesai: 15 }), '2026-10-23');
  assert.equal(r.signals.length, 0);
  assert.match(renderMarkdown(r), /\*\*无信号。\*\*/);
});

test('新闻解析与 L1 关键词对齐', () => {
  const xml = `<rss><channel><item><title><![CDATA[禾赛科技三季度毛利率下滑至 33% - 财新]]></title><link>https://x/1</link><pubDate>Fri, 23 Oct 2026 08:00:00 GMT</pubDate></item>
  <item><title>禾赛发布新品 - 36氪</title><link>https://x/2</link><pubDate>Fri, 23 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
  const items = tagItems(RULES.stocks[3], parseRss(xml));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].l1.map((h) => h.id), ['HS-1']);
  assert.equal(items[1].l1.length, 0);
  assert.deepEqual(matchKeywords('微信日活同比下滑', ['微信 日活']), ['微信 日活']);
});

test('新闻误报过滤：未点名本标的或只是普通提及的标题不命中', () => {
  const mk = (title) => ({ title, link: '', pubDate: '' });
  const [tc, mt, pm] = RULES.stocks;
  // 2026-10-23 实际误报样本
  assert.equal(tagItems(tc, [mk('澜起科技：完成本次A股回购方案，实际回购208.8万股耗资4.1亿元')])[0].l1.length, 0);
  assert.equal(tagItems(tc, [mk('南向资金追踪｜短线加仓腾讯大举减持中芯国际')])[0].l1.length, 0);
  assert.equal(tagItems(pm, [mk('陈奕恒泡泡更新，labubu开箱')])[0].l1.length, 0);
  assert.equal(tagItems(mt, [mk('官方1639元、批价1690元：茅台把经销商推到了哪一步？')])[0].l1.length, 0);
  assert.equal(tagItems(mt, [mk('飞天茅台价格持续企稳！白酒龙头逆市上涨')])[0].l1.length, 0);
  // 真信号仍然命中
  assert.deepEqual(tagItems(tc, [mk('腾讯宣布暂停回购')])[0].l1.map((h) => h.id), ['TC-4']);
  assert.deepEqual(tagItems(mt, [mk('飞天茅台批价跌破1500元')])[0].l1.map((h) => h.id), ['MT-1']);
  assert.deepEqual(tagItems(pm, [mk('泡泡玛特新品二手价跌破原价')])[0].l1.map((h) => h.id), ['PM-4']);
});

test('推送正文列出新闻标题、对应 L1 条件原文、命中词和链接', () => {
  const pm = RULES.stocks[2];
  const [it] = tagItems(pm, [{ title: '泡泡玛特Q3财报看点：营收预计下降三成 - 华尔街见闻', link: 'https://x/1', pubDate: '' }]);
  const sig = { type: 'NEWS', tag: '预警', msg: '1 条新闻命中 L1 关键词', details: [{ stock: pm.name, ...it }] };
  const body = renderPush({}, [{ type: 'BUY', tag: '买入', msg: '腾讯控股 触发 T1' }, sig]);
  assert.match(body, /泡泡玛特｜泡泡玛特Q3财报看点：营收预计下降三成/);
  assert.match(body, /PM-2 总收入连续 2 季同比负增长（命中：营收 下降）/);
  assert.match(body, /\[原文\]\(https:\/\/x\/1\)/);
  assert.match(body, /T1\n\n【预警】/);
});

test('建仓节点速览：列出每档价格、股数和距离', () => {
  const r = evaluateAll(RULES, quotes(BASE), '2026-10-23');
  const b = renderLadderBrief(r);
  assert.match(b, /\*\*腾讯控股\*\* 379\.8｜折价 41\.6%｜买入区/);
  assert.match(b, /T1 390 × 4,300 股（\*\*已触发\*\*）/);
  assert.match(b, /T2 360 × 5,300 股（还差 −5\.2%）/);
  assert.match(b, /M1 1180 × 800 股（还差 −11\.7%）/);
  assert.match(b, /H1b 11\.8 × 16,000 股（价格已到，待条件）/);
  assert.match(b, /减仓线 748（\+96\.9%）/);
  assert.match(b, /风控线 9\.82/);
  assert.match(b, /持仓 20,000 股 @12\.88/);
});

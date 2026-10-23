import { pct, wan } from './engine.mjs';

const ORDER = { L1_BREACH: 0, RISK: 1, SELL: 2, BUY: 3, BUY_WAIT: 4, NEAR_SELL: 5, NEAR_BUY: 6, L1_WARN: 7, L3: 8, IV_AUDIT: 9, DATA: 10, EVENT: 11 };
const ACTION = new Set(['L1_BREACH', 'RISK', 'SELL', 'BUY']);

export function sortSignals(signals) {
  return [...signals].sort((a, b) => (ORDER[a.type] ?? 99) - (ORDER[b.type] ?? 99));
}

export function headline(r) {
  const act = r.signals.filter((s) => ACTION.has(s.type));
  if (act.length) return `四标 ${r.today}：${act.length} 个操作信号`;
  const warn = r.signals.filter((s) => s.type !== 'EVENT');
  if (warn.length) return `四标 ${r.today}：无操作信号，${warn.length} 条预警`;
  return `四标 ${r.today}：无信号`;
}

const px = (s) => (s.price == null ? '—' : s.price.toLocaleString('en-US', { maximumFractionDigits: 2 }));

export function renderMarkdown(r, news = {}) {
  const L = [];
  L.push(`# 四标日报 ${r.today}`, '');
  L.push(`> 框架 ${r.version}　计划资金 ¥${wan(r.planCapitalCny)}万　已投 ¥${wan(r.investedCny)}万（${pct(r.investedCny / r.planCapitalCny)}）　现金 ¥${wan(r.cashCny)}万`, '');

  // 1. 信号（沉默原则：没有就明确写无信号）
  L.push('## 信号', '');
  const sigs = sortSignals(r.signals);
  if (!sigs.length) {
    L.push('**无信号。** 价格未触及任何买卖档，L1 清单无条目被踩到。按纪律：不动。', '');
  } else {
    for (const s of sigs) L.push(`- \`${s.tag}\` ${s.msg}`);
    L.push('');
  }

  // 2. 价格与折价率
  L.push('## 价格与折价率', '');
  L.push('| 标的 | 现价 | IV | 折价率 | IV 区间对应折价 | 区间 | 隐含年化 | 下一买入档 | 第一减仓线 | 行情源 |');
  L.push('|---|---:|---:|---:|---|---|---:|---|---|---|');
  for (const s of r.stocks) {
    const nb = s.buyLadder.find((t) => !t.filled);
    const nbTxt = nb ? `${nb.id} @${nb.price}（${nb.distance == null ? '—' : nb.distance <= 0 ? '已到' : '−' + pct(nb.distance / (1 + nb.distance))}）` : '已满';
    const sl = s.sellLines[0];
    const slTxt = `${sl.price}（${sl.distance == null ? '—' : sl.distance <= 0 ? '已到' : '+' + pct(sl.distance)}）`;
    if (s.price == null) {
      L.push(`| ${s.name} | — | ${s.iv} | — | — | — | — | ${nbTxt} | ${slTxt} | 失败 |`);
      continue;
    }
    L.push(`| ${s.name} | ${px(s)} | ${s.iv} | ${pct(s.discount)} | ${pct(s.discountRange[0])}~${pct(s.discountRange[1])} | ${s.zone} | ${pct(s.impliedReturn)} | ${nbTxt} | ${slTxt} | ${s.quote.source} |`);
  }
  L.push('');

  // 3. L1 清单汇总
  L.push('## L1 逻辑破坏清单', '');
  const all = r.stocks.flatMap((s) => s.l1.map((c) => ({ ...c, stock: s.name })));
  const bad = all.filter((c) => c.status === 'breach' || c.status === 'warn');
  const pending = all.filter((c) => c.status === 'pending');
  if (!bad.length) L.push(`共 ${all.length} 条，**无触发、无预警**。${pending.length ? `其中 ${pending.length} 条待补数据（${pending.map((c) => c.id).join('、')}），财报后在 rules.json 填入。` : ''}`);
  else for (const c of bad) L.push(`- ${c.status === 'breach' ? '🔴 触发' : '🟡 预警'} ${c.stock} ${c.id}：${c.text} —— ${c.detail}`);
  L.push('');

  // 4. 新闻核查
  const flagged = Object.entries(news).flatMap(([id, n]) => (n.flagged ?? []).map((it) => ({ ...it, stock: r.stocks.find((s) => s.id === id)?.name })));
  const failed = Object.entries(news).filter(([, n]) => !n.ok).map(([id]) => r.stocks.find((s) => s.id === id)?.name);
  if (Object.keys(news).length) {
    L.push('## 新闻核查（命中 L1 关键词，需人工判断）', '');
    if (!flagged.length) L.push('无命中。');
    for (const it of flagged) L.push(`- [${it.stock} · ${it.l1.map((h) => h.id).join('/')}] [${it.title}](${it.link})`);
    if (failed.length) L.push('', `新闻抓取失败：${failed.join('、')}`);
    L.push('');
  }

  // 5. 持仓
  const held = r.stocks.filter((s) => s.position.shares > 0);
  if (held.length) {
    L.push('## 持仓', '');
    for (const s of held) {
      const pnl = s.position.valueCny == null ? '' : `，市值 ¥${wan(s.position.valueCny)}万（${pct(s.position.valueCny / s.position.costCny - 1)}）`;
      L.push(`- ${s.name} ${s.position.shares.toLocaleString()} 股 @${s.position.avgCost}，成本 ¥${wan(s.position.costCny)}万${pnl}`);
    }
    L.push('');
  }

  L.push('---', '买不买看折价，什么价买看阶梯，什么时候卖看逻辑——不看点位。每次动作前回读一遍 L1 清单。');
  return L.join('\n') + '\n';
}

export function renderPush(r, signals) {
  return sortSignals(signals).map((s) => `【${s.tag}】${s.msg}`).join('\n');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderHtml(r, news = {}) {
  const tagClass = { 买入: 'buy', 减仓: 'sell', 逻辑破坏: 'break', 预警: 'warn', 风控: 'break', 提示: 'info', 持有: 'info' };
  const sigs = sortSignals(r.signals);
  const cards = r.stocks.map((s) => {
    const d = s.discount ?? null;
    // 刻度：-50%（IV+50%）到 +60% 折价
    const pos = (x) => Math.max(0, Math.min(100, ((x + 0.5) / 1.1) * 100));
    const ladder = s.buyLadder.map((t) => `<tr><td>${esc(t.id)}</td><td class="num">${t.price}</td><td class="num">${t.shares.toLocaleString()}</td><td class="num">¥${wan(t.amountCny)}万</td><td class="num">${pct(t.discount)}</td><td><span class="st st-${t.status === '已触发' ? 'hit' : t.status === '已成交' ? 'done' : t.status === '接近' ? 'near' : 'idle'}">${esc(t.status ?? '—')}</span></td></tr>`).join('');
    const sells = s.sellLines.map((l) => `<tr><td>IV+${l.premium * 100}%</td><td class="num">${l.price}</td><td>${esc(l.action)}</td><td class="num">${l.distance == null ? '—' : l.distance <= 0 ? '已到' : '+' + pct(l.distance)}</td></tr>`).join('');
    const l1 = s.l1.map((c) => `<li class="l1-${c.status}"><b>${c.id}</b> ${esc(c.text)}<br><small>${esc(c.detail)}</small></li>`).join('');
    const nf = news[s.id]?.flagged ?? [];
    const newsHtml = nf.length ? `<ul class="news">${nf.map((it) => `<li><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a> <small>${it.l1.map((h) => h.id).join('/')}</small></li>`).join('')}</ul>` : '<p class="muted">无命中 L1 关键词的新闻</p>';
    return `<section class="card">
  <header><div><h2>${esc(s.name)}</h2><span class="muted">${esc(s.code)} · 3R ${s.score3R}/30 · 预算 ¥${wan(s.budgetCny)}万</span></div>
  <div class="big"><span class="num">${s.price ?? '—'}</span><small>${s.currency}</small></div></header>
  <div class="kpis"><div><small>内在价值</small><b class="num">${s.iv}</b><small>${s.ivRange.join('–')}</small></div>
  <div><small>折价率</small><b class="num">${d == null ? '—' : pct(d)}</b><small>${esc(s.zone ?? '')}</small></div>
  <div><small>隐含年化</small><b class="num">${s.impliedReturn == null ? '—' : pct(s.impliedReturn)}</b><small>${s.logicBroken ? 'L1 破坏' : 'L1 正常'}</small></div></div>
  <div class="bar"><span class="z z0" style="left:0;width:${pos(0)}%"></span><span class="z z1" style="left:${pos(0)}%;width:${pos(0.3) - pos(0)}%"></span><span class="z z2" style="left:${pos(0.3)}%;width:${pos(0.4) - pos(0.3)}%"></span><span class="z z3" style="left:${pos(0.4)}%;width:${pos(0.5) - pos(0.4)}%"></span><span class="z z4" style="left:${pos(0.5)}%;right:0"></span>${d == null ? '' : `<i style="left:${pos(d)}%"></i>`}</div>
  <div class="barlbl">${[[-0.25, '减仓'], [0.15, '持有'], [0.35, '观察'], [0.45, '买入'], [0.55, '重仓']].map(([x, t]) => `<span style="left:${pos(x)}%">${t}</span>`).join('')}</div>
  <h3>买入阶梯</h3><table><thead><tr><th>档</th><th>价格</th><th>股数</th><th>金额</th><th>折价</th><th>状态</th></tr></thead><tbody>${ladder}</tbody></table>
  ${s.riskLine ? `<p class="muted">${esc(s.riskLine.note)}：${s.riskLine.price}${s.riskLine.hit ? ' — <b>已跌破</b>' : ''}</p>` : ''}
  <h3>卖出 L2</h3><table><thead><tr><th>线</th><th>价格</th><th>动作</th><th>距离</th></tr></thead><tbody>${sells}</tbody></table>
  <h3>L1 逻辑破坏清单</h3><ul class="l1">${l1}</ul>
  <h3>今日新闻核查</h3>${newsHtml}
</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>四标纪律看板</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--mut:#6b6b66;--line:#e4e4df;--buy:#1f7a4d;--sell:#b5522b;--break:#b3261e;--warn:#a87400;--info:#3b5b9a;
--z0:#e9c3b4;--z1:#e6e6e0;--z2:#d6e4d0;--z3:#a9cfb1;--z4:#6fae84}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecece8;--mut:#9a9a93;--line:#33332f;--buy:#5cc28d;--sell:#e58a62;--break:#f07167;--warn:#e0b04a;--info:#8aa6e0;
--z0:#6b3a2a;--z1:#3a3a36;--z2:#33473a;--z3:#2f6045;--z4:#3f8a5d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"PingFang SC","Noto Sans SC",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.muted{color:var(--mut)}
.num{font-variant-numeric:tabular-nums}.sigs{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:16px 0}
.sigs li{margin:4px 0}.tag{display:inline-block;font-size:12px;padding:0 6px;border-radius:4px;margin-right:6px;color:#fff}
.tag.buy{background:var(--buy)}.tag.sell{background:var(--sell)}.tag.break{background:var(--break)}.tag.warn{background:var(--warn)}.tag.info{background:var(--info)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;min-width:0}
.card header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.card h2{margin:0;font-size:18px}
.big{font-size:26px;font-weight:600}.big small{font-size:12px;color:var(--mut);margin-left:4px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.kpis div{display:flex;flex-direction:column}.kpis b{font-size:18px}.kpis small{color:var(--mut)}
.bar{position:relative;height:10px;border-radius:5px;overflow:hidden;margin-top:4px}.z{position:absolute;top:0;bottom:0}.z0{background:var(--z0)}.z1{background:var(--z1)}.z2{background:var(--z2)}.z3{background:var(--z3)}.z4{background:var(--z4)}
.bar i{position:absolute;top:-2px;bottom:-2px;width:3px;background:var(--fg);transform:translateX(-1px)}
.barlbl{position:relative;height:16px;font-size:11px;color:var(--mut);margin-top:2px}.barlbl span{position:absolute;transform:translateX(-50%);white-space:nowrap}
h3{font-size:13px;margin:16px 0 6px;color:var(--mut);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:500}td.num,th.num{text-align:right}
.st{font-size:12px;padding:0 6px;border-radius:4px}.st-hit{background:var(--buy);color:#fff}.st-near{background:var(--warn);color:#fff}.st-done{background:var(--info);color:#fff}.st-idle{color:var(--mut)}
ul.l1{padding-left:0;list-style:none;margin:0}ul.l1 li{padding:6px 8px;border-left:3px solid var(--line);margin:4px 0}
.l1-breach{border-color:var(--break)!important}.l1-warn{border-color:var(--warn)!important}.l1-ok{border-color:var(--buy)!important}
ul.news{padding-left:18px;margin:0}a{color:var(--info)}
@media (max-width:420px){.grid{grid-template-columns:1fr}.kpis b{font-size:16px}}
</style></head><body><main>
<h1>四标投资纪律看板 · ${r.today}</h1>
<div class="muted">框架 ${r.version}　已投 ¥${wan(r.investedCny)}万（${pct(r.investedCny / r.planCapitalCny)}）　现金 ¥${wan(r.cashCny)}万　计划 ¥${wan(r.planCapitalCny)}万</div>
<div class="sigs"><b>今日信号</b>${sigs.length ? `<ul>${sigs.map((s) => `<li><span class="tag ${tagClass[s.tag] ?? 'info'}">${esc(s.tag)}</span>${esc(s.msg)}</li>`).join('')}</ul>` : '<p>无信号。按纪律：不动。</p>'}</div>
<div class="grid">${cards}</div>
<p class="muted">所有档位价格都是「到了就做什么」的条件句式，不是对价格的预测。本页为个人投资纪律记录，不构成投资建议。</p>
</main></body></html>
`;
}

#!/usr/bin/env node
// 四标投资纪律监控
//   node monitor.mjs                    收盘日报：抓价 → 折价率/区间 → 买卖档 → L1 → 新闻核查 → 报告 + 提醒
//   node monitor.mjs --mode intraday    盘中巡检：只看价格信号，只推送「新出现」的信号
//   node monitor.mjs --mode open        开盘提醒：建仓节点与价格（无论有无信号都推一次）
//   node monitor.mjs --offline          不联网，用 rules.json 里的 lastPrice 复核
//   node monitor.mjs --price tencent=360 --price hesai=10.5   手动覆盖价格（压力测试）
//   其它：--no-news --no-notify --no-write --force --date YYYY-MM-DD

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateAll } from './lib/engine.mjs';
import { fetchQuotes } from './lib/quotes.mjs';
import { fetchNews } from './lib/news.mjs';
import { notify } from './lib/notify.mjs';
import { renderMarkdown, renderHtml, renderPush, renderLadderBrief, headline } from './lib/report.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RULES = join(ROOT, 'rules.json');
const STATE = join(ROOT, 'state', 'state.json');
const DAILY = join(ROOT, 'daily');

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'daily' },
    offline: { type: 'boolean', default: false },
    price: { type: 'string', multiple: true, default: [] },
    'no-news': { type: 'boolean', default: false },
    'no-notify': { type: 'boolean', default: false },
    'no-write': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    date: { type: 'string' },
  },
});

const shanghaiDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);

// 行情时间 → 上海日期，用于判断是否休市/停牌（行情日期 ≠ 今天）
function quoteDate(q) {
  if (!q?.time) return null;
  const digits = String(q.time).replace(/\D/g, '');
  if (q.source === 'tencent' && digits.length >= 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const t = Date.parse(q.time);
  return Number.isFinite(t) ? shanghaiDate(new Date(t)) : null;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const rules = await readJson(RULES);
  if (!rules) throw new Error(`无法读取 ${RULES}`);
  const state = await readJson(STATE, { fired: {}, lastRun: null });
  const today = args.date ?? shanghaiDate();
  if (!['daily', 'intraday', 'open'].includes(args.mode)) throw new Error(`未知 --mode ${args.mode}（daily / intraday / open）`);
  const intraday = args.mode === 'intraday';
  const open = args.mode === 'open';
  const quick = intraday || open; // 不抓新闻、不写日报

  // 1. 行情
  let quotes = {};
  if (args.offline) {
    for (const s of rules.stocks) quotes[s.id] = { price: s.lastPrice, source: 'rules.json', time: rules.baseDate };
  } else {
    quotes = await fetchQuotes(rules.stocks);
  }
  for (const p of args.price) {
    const [id, v] = p.split('=');
    if (!rules.stocks.some((s) => s.id === id)) throw new Error(`--price 未知标的 ${id}（可用：${rules.stocks.map((s) => s.id).join(', ')}）`);
    quotes[id] = { price: Number(v), source: 'manual', time: today };
  }
  for (const q of Object.values(quotes)) q.stale = !args.offline && q.source !== 'manual' && quoteDate(q) !== today;

  const live = Object.values(quotes).filter((q) => !q.stale);
  if (!args.force && !args.offline && live.length === 0 && Object.keys(quotes).length > 0) {
    console.error(`[monitor] ${today} 所有行情都不是今日数据（休市/非交易日），跳过。用 --force 强制运行。`);
    return;
  }

  // 2. 评估
  const result = evaluateAll(rules, quotes, today);

  // 3. 新闻（仅日报）
  const news = {};
  if (!quick && !args['no-news'] && !args.offline) {
    for (const s of rules.stocks) news[s.id] = await fetchNews(s, { lookbackHours: rules.alerts.newsLookbackHours });
    // 新闻汇总成一条提醒（每天一次），附每条新闻的标题、对应的 L1 条件、命中词和原文链接
    const details = rules.stocks.flatMap((s) => news[s.id].flagged.map((it) => ({ stock: s.name, ...it })));
    if (details.length) {
      const counts = rules.stocks.map((s) => [s.name, news[s.id].flagged.length]).filter(([, n]) => n > 0);
      result.signals.push({ type: 'NEWS', tag: '预警', key: `news:${today}`, push: true, details,
        msg: `${details.length} 条新闻命中 L1 关键词，需人工核查（${counts.map(([n, c]) => `${n} ${c}`).join('、')}）` });
    }
  }

  // 4. 去重：同一信号只在首次出现时推送；条件消失后清除，再次出现会重新提醒
  const active = result.signals.filter((s) => s.push);
  const fresh = args.force ? active : active.filter((s) => !state.fired[s.key]);
  const failed = new Set(result.stocks.filter((s) => s.price == null).map((s) => s.id));
  const activeKeys = new Set(active.map((s) => s.key));
  const fired = {};
  for (const [k, v] of Object.entries(state.fired)) {
    const stockId = k.split(':')[0];
    // 行情失败的标的保留其旧记录，避免恢复后重复推送；新闻只在日报评估，盘中保留
    if (activeKeys.has(k) || failed.has(stockId) || (quick && stockId === 'news')) fired[k] = v;
  }
  for (const s of active) fired[s.key] ??= today;

  // 5. 输出
  const md = renderMarkdown(result, news);
  if (!args['no-write']) {
    await mkdir(join(ROOT, 'state'), { recursive: true });
    await writeFile(STATE, JSON.stringify({ fired, lastRun: new Date().toISOString(), lastMode: args.mode }, null, 2) + '\n');
    if (!quick) {
      await mkdir(DAILY, { recursive: true });
      await writeFile(join(DAILY, `${today}.md`), md);
      await writeFile(join(DAILY, 'latest.json'), JSON.stringify({ ...result, news }, null, 2) + '\n');
      await writeFile(join(DAILY, 'dashboard.html'), renderHtml(result, news));
    }
  }
  console.log(md);

  // 6. 提醒
  if (args['no-notify']) return;
  if (intraday) {
    if (fresh.length) await notify(`四标盘中提醒 ${today}：${fresh.length} 条新信号`, renderPush(result, fresh));
    return;
  }
  // 开盘 / 收盘：无论有无信号都推一次建仓节点（rules.alerts.ladderReminder 可关）
  const remind = rules.alerts.ladderReminder !== false;
  const always = remind || rules.alerts.pushDailyDigest === 'always';
  if (!active.length && !always) return;
  const sig = active.length ? renderPush(result, active) : '无触发信号。价格未触及任何买卖档，L1 清单无条目被踩到。';
  const body = remind ? `${sig}\n\n---\n\n${renderLadderBrief(result)}` : sig;
  const title = open ? `四标开盘 ${today}：${active.length ? headline(result).split('：')[1] : '无信号'}` : headline(result);
  await notify(title, body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

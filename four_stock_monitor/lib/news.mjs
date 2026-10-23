// 每日信息追踪：按标的抓 Google News RSS，过滤最近 N 小时，并把标题与 L1 关键词对齐。
// 命中只代表「需要人工核查」，不会自动把 L1 判为触发——触发必须由人改 rules.json。

const UA = 'Mozilla/5.0 (four-stock-monitor)';

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => {
      const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return r ? decode(r[1]) : '';
    };
    items.push({ title: pick('title'), link: pick('link'), pubDate: pick('pubDate'), source: pick('source') });
  }
  return items;
}

// 关键词支持空格分隔的「与」：如 "微信 日活" 要求两个词都出现
export function matchKeywords(title, keywords) {
  const t = title.toLowerCase();
  return keywords.filter((k) => k.toLowerCase().split(/\s+/).every((p) => t.includes(p)));
}

// 标题必须点名本标的（aliases），否则搜索结果里的其他公司新闻（如别家回购）会误报
export function mentionsStock(stock, title) {
  const aliases = stock.news?.aliases ?? [stock.name];
  const t = title.toLowerCase();
  return aliases.some((a) => t.includes(a.toLowerCase()));
}

export function tagItems(stock, items) {
  return items.map((it) => {
    const hits = [];
    if (!mentionsStock(stock, it.title)) return { ...it, l1: hits };
    for (const c of stock.l1) {
      const kw = matchKeywords(it.title, c.keywords ?? []);
      if (kw.length) hits.push({ id: c.id, text: c.text, keywords: kw });
    }
    return { ...it, l1: hits };
  });
}

export async function fetchNews(stock, { lookbackHours = 30, now = Date.now(), log = console.error } = {}) {
  const seen = new Set();
  const all = [];
  for (const q of stock.news?.query ?? []) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(String(res.status));
      for (const it of parseRss(await res.text())) {
        const t = Date.parse(it.pubDate);
        if (Number.isFinite(t) && now - t > lookbackHours * 3600e3) continue;
        const k = it.title.replace(/\s+-\s+[^-]+$/, '');
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(it);
      }
    } catch (e) {
      log(`[news] ${stock.name} "${q}" 失败: ${e.message}`);
      return { ok: false, items: [], flagged: [], error: e.message };
    }
  }
  const tagged = tagItems(stock, all);
  return { ok: true, items: tagged, flagged: tagged.filter((x) => x.l1.length) };
}

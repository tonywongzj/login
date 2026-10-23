// 行情抓取：腾讯财经（主）→ 东方财富 → 雅虎（备）。任一源成功即返回。

const UA = 'Mozilla/5.0 (four-stock-monitor)';

async function get(url, { timeout = 10000, encoding } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.qq.com' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  if (encoding) return new TextDecoder(encoding).decode(await res.arrayBuffer());
  return res.text();
}

// qt.gtimg.cn 一次批量返回：v_hk00700="100~腾讯控股~00700~379.800~380.000~...";
export async function fromTencent(stocks) {
  const codes = stocks.map((s) => s.quote.tencent).join(',');
  const text = await get(`https://qt.gtimg.cn/q=${codes}`, { encoding: 'gbk' });
  const out = {};
  for (const s of stocks) {
    const m = text.match(new RegExp(`v_${s.quote.tencent}="([^"]*)"`));
    if (!m) continue;
    const f = m[1].split('~');
    const price = parseFloat(f[3]);
    if (!(price > 0)) continue;
    out[s.id] = {
      price,
      prevClose: parseFloat(f[4]) || null,
      high: parseFloat(f[33]) || null,
      low: parseFloat(f[34]) || null,
      time: f[30] ?? null,
      source: 'tencent',
    };
  }
  return out;
}

export async function fromEastmoney(stock) {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${stock.quote.eastmoney}&fltt=2&fields=f43,f44,f45,f60,f86`;
  const j = JSON.parse(await get(url));
  const d = j?.data;
  if (!d || !(d.f43 > 0)) throw new Error('eastmoney: no data');
  return {
    price: d.f43,
    high: d.f44 || null,
    low: d.f45 || null,
    prevClose: d.f60 || null,
    time: d.f86 ? new Date(d.f86 * 1000).toISOString() : null,
    source: 'eastmoney',
  };
}

export async function fromYahoo(stock) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.quote.yahoo)}?range=1d&interval=1d`;
  const j = JSON.parse(await get(url));
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || !(m.regularMarketPrice > 0)) throw new Error('yahoo: no data');
  return {
    price: m.regularMarketPrice,
    prevClose: m.chartPreviousClose ?? null,
    high: m.regularMarketDayHigh ?? null,
    low: m.regularMarketDayLow ?? null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    source: 'yahoo',
  };
}

export async function fetchQuotes(stocks, log = console.error) {
  let out = {};
  try {
    out = await fromTencent(stocks);
  } catch (e) {
    log(`[quotes] tencent 失败: ${e.message}`);
  }
  for (const s of stocks) {
    if (out[s.id]) continue;
    for (const fn of [fromEastmoney, fromYahoo]) {
      try {
        out[s.id] = await fn(s);
        break;
      } catch (e) {
        log(`[quotes] ${s.code} ${fn.name} 失败: ${e.message}`);
      }
    }
  }
  return out;
}

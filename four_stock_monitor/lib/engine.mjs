// 纯计算：给定 rules + 行情，输出每个标的的折价率、区间、买卖档状态、L1 状态和信号。
// 没有任何网络/文件 I/O，便于测试和离线复核。

export const TAGS = {
  BUY: '买入',
  HOLD: '持有',
  SELL: '减仓',
  BREAK: '逻辑破坏',
  WARN: '预警',
  RISK: '风控',
  INFO: '提示',
};

const OPS = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function discountOf(price, iv) {
  return 1 - price / iv;
}

export function zoneOf(discount, zones) {
  for (const z of zones) {
    const lo = z.minDiscount ?? -Infinity;
    const hi = z.maxDiscount ?? Infinity;
    if (discount >= lo && discount < hi) return z.name;
  }
  return zones[zones.length - 1].name;
}

// 隐含年化：现价向 IV 在 N 年内收敛，叠加 8% 机会成本线。仅作 L3 换仓比较用的粗略刻度。
export function impliedReturn(price, iv, rate, years) {
  return (1 + rate) * Math.pow(iv / price, 1 / years) - 1;
}

// L1 单条判定。status: ok | warn | breach | pending(缺数据)
export function evalL1(cond, today) {
  const op = OPS[cond.op];
  const fmt = (v) => `${v}${cond.unit ?? ''}`;
  // 距离阈值的安全垫（相对阈值）
  const cushion = (v) => (cond.threshold === 0 ? null : Math.abs(v - cond.threshold) / Math.abs(cond.threshold));
  const nearWarn = (v) => isNum(cond.warnPct) && !op(v, cond.threshold) && cushion(v) <= cond.warnPct;

  switch (cond.kind) {
    case 'manual':
      return cond.triggered
        ? { status: 'breach', detail: '已人工确认触发' }
        : { status: 'ok', detail: '人工核查项，未触发' };

    case 'threshold': {
      if (!isNum(cond.value)) return { status: 'pending', detail: '待填数据' };
      const c = cushion(cond.value);
      const pad = c === null ? '' : `，安全垫 ${(c * 100).toFixed(0)}%`;
      if (op(cond.value, cond.threshold)) return { status: 'breach', detail: `当前 ${fmt(cond.value)} ${cond.op} ${fmt(cond.threshold)}` };
      if (nearWarn(cond.value)) return { status: 'warn', detail: `当前 ${fmt(cond.value)} 接近阈值 ${fmt(cond.threshold)}${pad}` };
      return { status: 'ok', detail: `当前 ${fmt(cond.value)}，阈值 ${fmt(cond.threshold)}${pad}` };
    }

    case 'series': {
      const vals = (cond.values ?? []).filter(isNum);
      if (vals.length === 0) return { status: 'pending', detail: '待填数据' };
      const tail = vals.slice(-cond.n);
      const hits = tail.filter((v) => op(v, cond.threshold)).length;
      const last = vals[vals.length - 1];
      // 连续计数：从最新一期往前数满足条件的期数
      let streak = 0;
      for (let i = vals.length - 1; i >= 0 && op(vals[i], cond.threshold); i--) streak++;
      if (tail.length >= cond.n && hits === cond.n) {
        return { status: 'breach', detail: `最近 ${cond.n} 期全部 ${cond.op} ${fmt(cond.threshold)}（${tail.map(fmt).join(', ')}）` };
      }
      if (streak > 0) return { status: 'warn', detail: `已连续 ${streak}/${cond.n} 期 ${cond.op} ${fmt(cond.threshold)}，最新 ${fmt(last)}` };
      if (nearWarn(last)) return { status: 'warn', detail: `最新 ${fmt(last)} 接近阈值 ${fmt(cond.threshold)}` };
      return { status: 'ok', detail: `最新 ${fmt(last)}，连续 0/${cond.n} 期` };
    }

    case 'deadline': {
      const past = today > cond.deadline;
      if (!isNum(cond.value)) {
        return past ? { status: 'warn', detail: `已过观察期 ${cond.deadline} 但数据未填，需立即核查` } : { status: 'pending', detail: `待填数据（观察期至 ${cond.deadline}）` };
      }
      const failing = op(cond.value, cond.threshold);
      if (failing && past) return { status: 'breach', detail: `观察期 ${cond.deadline} 已过，当前 ${fmt(cond.value)} 仍 ${cond.op} ${fmt(cond.threshold)}` };
      if (failing) return { status: 'warn', detail: `当前 ${fmt(cond.value)}，需在 ${cond.deadline} 前修复` };
      return { status: 'ok', detail: `当前 ${fmt(cond.value)}，已满足` };
    }

    case 'and': {
      const parts = cond.parts.map((p) => ({ ...p, has: isNum(p.value), hit: isNum(p.value) && OPS[p.op](p.value, p.threshold) }));
      const desc = parts.map((p) => `${p.label} ${p.has ? p.value + (p.unit ?? '') : '待填'}`).join('；');
      if (parts.every((p) => p.hit)) return { status: 'breach', detail: desc };
      if (parts.some((p) => p.hit)) return { status: 'warn', detail: `部分条件已满足：${desc}` };
      if (parts.some((p) => !p.has)) return { status: 'pending', detail: desc };
      return { status: 'ok', detail: desc };
    }

    default:
      return { status: 'pending', detail: `未知类型 ${cond.kind}` };
  }
}

export function evaluateStock(stock, quote, rules, today) {
  const fx = rules.fx[stock.currency] ?? 1;
  const price = quote?.price ?? null;
  const out = {
    id: stock.id,
    name: stock.name,
    code: stock.code,
    currency: stock.currency,
    iv: stock.iv,
    ivRange: stock.ivRange,
    score3R: stock.score3R,
    budgetCny: stock.budgetCny,
    quote: quote ?? null,
    price,
    signals: [],
  };

  // L1 先算：逻辑破坏时压制所有买入信号（越便宜越是陷阱）
  out.l1 = stock.l1.map((c) => ({ id: c.id, text: c.text, ...evalL1(c, today) }));
  const broken = out.l1.filter((c) => c.status === 'breach');
  out.logicBroken = broken.length > 0;
  for (const c of broken) {
    out.signals.push({ type: 'L1_BREACH', tag: TAGS.BREAK, key: `${stock.id}:l1:${c.id}`, push: true,
      msg: `${stock.name} L1 ${c.id} 触发：${c.text}（${c.detail}）→ 清仓，不看价格` });
  }
  for (const c of out.l1.filter((c) => c.status === 'warn')) {
    out.signals.push({ type: 'L1_WARN', tag: TAGS.WARN, key: `${stock.id}:l1warn:${c.id}`, push: true,
      msg: `${stock.name} L1 ${c.id} 预警：${c.detail}` });
  }

  const pos = stock.position ?? { shares: 0, avgCost: 0 };
  out.position = { ...pos, costCny: pos.shares * pos.avgCost * fx, valueCny: price ? pos.shares * price * fx : null };

  out.buyLadder = stock.buyLadder.map((t) => ({
    ...t,
    discount: discountOf(t.price, stock.iv),
    amountCny: t.shares * t.price * fx,
    distance: price ? price / t.price - 1 : null,
  }));
  out.sellLines = rules.sellLadder.map((s) => ({
    ...s,
    // +1e-9 抵消浮点误差（650 × 1.15 = 747.4999…）
    price: +(stock.iv * (1 + s.premium) + 1e-9).toFixed(stock.iv < 100 ? 1 : 0),
  }));
  for (const s of out.sellLines) s.distance = price ? s.price / price - 1 : null;

  if (price === null) {
    out.signals.push({ type: 'DATA', tag: TAGS.INFO, key: `${stock.id}:data`, push: true, msg: `${stock.name} 行情获取失败，今日未判定价格信号` });
    return out;
  }

  out.discount = discountOf(price, stock.iv);
  out.zone = zoneOf(out.discount, rules.zones);
  out.impliedReturn = impliedReturn(price, stock.iv, rules.discountRate, rules.convergeYears);
  const [ivLo, ivHi] = stock.ivRange;
  out.discountRange = [discountOf(price, ivLo), discountOf(price, ivHi)];

  // 买入档
  const near = rules.alerts.nearBuyPct;
  for (const t of out.buyLadder) {
    if (t.filled) { t.status = '已成交'; continue; }
    if (price <= t.price) {
      if (out.logicBroken) {
        t.status = '已触发（L1 破坏，禁止买入）';
        continue;
      }
      if (t.condition && !t.conditionMet) {
        t.status = '价格到位，等待条件';
        out.signals.push({ type: 'BUY_WAIT', tag: TAGS.WARN, key: `${stock.id}:buywait:${t.id}`, push: true,
          msg: `${stock.name} ${t.id} @${t.price} 价格已到，但前置条件未确认：${t.condition}` });
        continue;
      }
      t.status = '已触发';
      out.signals.push({ type: 'BUY', tag: TAGS.BUY, key: `${stock.id}:buy:${t.id}`, push: true,
        msg: `${stock.name} 触发 ${t.id}：现价 ${price} ≤ ${t.price}，买 ${t.shares.toLocaleString()} 股（≈¥${wan(t.shares * price * fx)}万，折价 ${pct(out.discount)}）` });
    } else if (t.distance <= near) {
      t.status = '接近';
      out.signals.push({ type: 'NEAR_BUY', tag: TAGS.WARN, key: `${stock.id}:nearbuy:${t.id}`, push: true,
        msg: `${stock.name} 距 ${t.id} @${t.price} 仅 ${pct(t.distance)}（现价 ${price}）` });
    } else {
      t.status = '未到';
    }
  }

  // 卖出 L2（只对有持仓的标的发信号）
  const nearSell = rules.alerts.nearSellPct;
  for (const s of out.sellLines) {
    if (price >= s.price) {
      s.status = '已触发';
      if (pos.shares > 0) {
        out.signals.push({ type: 'SELL', tag: TAGS.SELL, key: `${stock.id}:sell:${s.premium}`, push: true,
          msg: `${stock.name} 现价 ${price} ≥ IV+${s.premium * 100}% (${s.price}) → ${s.action}` });
      }
    } else if (s.distance <= nearSell) {
      s.status = '接近';
      if (pos.shares > 0) {
        out.signals.push({ type: 'NEAR_SELL', tag: TAGS.WARN, key: `${stock.id}:nearsell:${s.premium}`, push: true,
          msg: `${stock.name} 距减仓线 ${s.price}（${s.action}）仅 ${pct(s.distance)}` });
      }
    } else {
      s.status = '未到';
    }
  }

  // 可选风控线
  if (stock.riskLine) {
    out.riskLine = { ...stock.riskLine, hit: price <= stock.riskLine.price };
    if (out.riskLine.hit && pos.shares > 0) {
      out.signals.push({ type: 'RISK', tag: TAGS.RISK, key: `${stock.id}:risk`, push: true,
        msg: `${stock.name} 跌破可选风控线 ${stock.riskLine.price}（现价 ${price}）——仓位纪律，不是估值卖出依据，执行前回读 L1` });
    }
  }

  // IV 修改纪律：最新 ivHistory 必须与 iv 一致并写明依据
  const lastIv = stock.ivHistory?.[stock.ivHistory.length - 1];
  if (!lastIv || lastIv.iv !== stock.iv || !lastIv.reason) {
    out.signals.push({ type: 'IV_AUDIT', tag: TAGS.WARN, key: `${stock.id}:ivaudit:${stock.iv}`, push: true,
      msg: `${stock.name} IV=${stock.iv} 与 ivHistory 最新记录不一致或缺少依据——IV 只在财报后改，且必须写明依据` });
  }

  return out;
}

// L3 换仓：另一标的隐含年化高出 ≥8pp 且 3R 不低于持仓标的；只在现金不足以执行其下一档时才有意义
export function evaluateL3(results, rules, cashCny) {
  const out = [];
  const held = results.filter((r) => r.position.shares > 0 && r.price && !r.logicBroken);
  const candidates = results.filter((r) => r.price && !r.logicBroken);
  for (const h of held) {
    for (const c of candidates) {
      if (c.id === h.id) continue;
      const excess = c.impliedReturn - h.impliedReturn;
      if (excess < rules.l3.minExcessReturn || c.score3R < h.score3R) continue;
      const next = c.buyLadder.find((t) => !t.filled && t.status === '已触发');
      if (!next || next.amountCny <= cashCny) continue;
      out.push({ type: 'L3', tag: TAGS.INFO, key: `l3:${h.id}->${c.id}`, push: true,
        msg: `换仓评估：${c.name} 隐含年化 ${pct(c.impliedReturn)} 比 ${h.name} 高 ${pct(excess)}，3R ${c.score3R} ≥ ${h.score3R}，且现金不足执行 ${next.id}` });
    }
  }
  return out;
}

export function upcomingEvents(rules, today, days = 14) {
  const end = addDays(today, days);
  return (rules.events ?? []).filter((e) => {
    const until = e.until ?? e.date;
    return e.date <= end && until >= today;
  });
}

export function evaluateAll(rules, quotes, today) {
  const stocks = rules.stocks.map((s) => evaluateStock(s, quotes[s.id], rules, today));
  const investedCny = stocks.reduce((a, s) => a + s.position.costCny, 0);
  const cashCny = rules.planCapitalCny - investedCny;
  const l3 = evaluateL3(stocks, rules, cashCny);
  const events = upcomingEvents(rules, today);
  const signals = [...stocks.flatMap((s) => s.signals.map((x) => ({ ...x, stock: s.id }))), ...l3];
  for (const e of events) {
    signals.push({ type: 'EVENT', tag: TAGS.INFO, key: `event:${e.stock}:${e.date}`, push: true, stock: e.stock,
      msg: `日程（${e.date}${e.until ? '~' + e.until : ''}）：${e.text}` });
  }
  return {
    today,
    version: rules.version,
    planCapitalCny: rules.planCapitalCny,
    investedCny,
    cashCny,
    stocks,
    l3,
    events,
    signals,
  };
}

export function pct(x, d = 1) {
  return `${(x * 100).toFixed(d)}%`;
}
export function wan(x) {
  return (x / 10000).toFixed(1);
}
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

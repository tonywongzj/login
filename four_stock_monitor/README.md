# 四标投资纪律监控

腾讯控股 0700.HK · 贵州茅台 600519.SH · 泡泡玛特 9992.HK · 禾赛科技-W 02525.HK

> 买不买看折价，什么价买看阶梯，什么时候卖看逻辑——不看点位。

零依赖，Node.js ≥ 20。所有规则都在 `rules.json`，程序只负责「到了就提醒」。

## 三个模块

| 模块 | 做什么 | 规则位置 |
|---|---|---|
| **买入价** | 现价 vs 内在价值 → 折价率 → 区间（减仓/持有/观察/买入/加仓/重仓）；逐档检查买入阶梯是否触发、是否接近（3% 内） | `stocks[].iv` `ivRange` `buyLadder` `zones` |
| **每日信息追踪** | L1 逻辑破坏清单逐条判定；按标的抓当日新闻，标题命中 L1 关键词的列入「需人工核查」；财报等日程提前 14 天提醒 | `stocks[].l1` `news.query` `events` |
| **卖出价** | L1 破坏 → 清仓（不看价格，同时禁止该标的所有买入）；L2 价格高于 IV 15%/30%/50% → 减 1/3 / 减到半仓 / 清仓；L3 换仓评估；禾赛可选风控线 | `sellLadder` `riskLine` `l3` |

## 提醒机制

| 时间（北京） | 模式 | 推送什么 |
|---|---|---|
| 交易日 09:35 | `open` 开盘提醒 | **必推一次**：当前信号（没有就写「无触发信号」）+ 建仓节点（每档价格、股数、还差多少） |
| 交易日 09:00–16:30 每 30 分钟 | `intraday` 盘中巡检 | 只推**新出现**的信号（同一档触发只提醒一次；价格离开后再回来会再提醒） |
| 交易日 17:30 | `daily` 收盘日报 | 写 `daily/YYYY-MM-DD.md`、`daily/dashboard.html`、`daily/latest.json`；**必推一次**：信号 + 新闻核查 + 建仓节点 |

不想要开盘/收盘的固定提醒：把 `rules.json` 里 `alerts.ladderReminder` 改成 `false`，就回到「没信号不打扰」。

信号标签：`买入` `减仓` `逻辑破坏` `风控` `预警` `提示`。休市日（行情日期不是今天）自动跳过。

### 推送渠道（GitHub 仓库 → Settings → Secrets and variables → Actions）

配置任意一个或多个 **Secret** 即启用：

| Secret | 渠道 |
|---|---|
| `SERVERCHAN_SENDKEY` | Server 酱 → 微信（最省事） |
| `BARK_URL` | Bark → iPhone，如 `https://api.day.app/xxxx` |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram |
| `WECOM_WEBHOOK` / `DINGTALK_WEBHOOK` / `FEISHU_WEBHOOK` | 企业微信 / 钉钉 / 飞书群机器人（钉钉安全关键词设为「四标」） |

另外可设 **Variable** `NOTIFY_GITHUB_ISSUE=1`：每条提醒开一个 Issue，GitHub 会发邮件和 App 通知，无需任何第三方账号。

> GitHub 的定时任务只在**默认分支**上运行：把本分支合并到 main 后才会自动跑。也可以在 Actions 页面手动 Run workflow。

### 准点触发：cron-job.org

GitHub 自带的定时任务只是「尽量执行」：2026-10-26 的开盘提醒晚了 5 小时，收盘日报拖到次日 00:13，盘中巡检大多被丢弃。要准点，就用 [cron-job.org](https://cron-job.org)（免费，精确到分钟）按时调用 GitHub 接口来触发工作流。GitHub 自带的定时任务保留作兜底；开盘、收盘提醒每天只推一次，两边都触发也不会重复。

**1. GitHub 令牌**（只能触发本仓库的 Actions）
头像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
- Repository access：Only select repositories → `login`
- Permissions → Repository permissions → **Actions: Read and write**
- 有效期选最长；到期前记得换新令牌，否则准点推送会停

**2. cron-job.org 建 3 个任务**（时区选 Asia/Shanghai，日期选周一到周五）

| 任务 | 时间 | Request body |
|---|---|---|
| 四标开盘 | 09:35 | `{"ref":"main","inputs":{"mode":"open"}}` |
| 四标收盘 | 17:30 | `{"ref":"main","inputs":{"mode":"daily"}}` |
| 四标盘中（可选） | 10:00–16:00 每 30 分钟 | `{"ref":"main","inputs":{"mode":"intraday"}}` |

三个任务共用的设置：
- URL：`https://api.github.com/repos/tonywongzj/login/actions/workflows/four-stock-monitor.yml/dispatches`
- Request method：`POST`
- Headers：`Authorization: Bearer <令牌>`、`Accept: application/vnd.github+json`、`Content-Type: application/json`

建好后点 Test run，返回 **204** 就是成功，GitHub 的 Actions 页面会立刻出现一次 `workflow_dispatch` 运行。

## 本地运行

```bash
cd four_stock_monitor
node monitor.mjs                       # 收盘日报（联网抓价 + 新闻 + 推送）
node monitor.mjs --mode intraday       # 盘中巡检
npm run check                          # 离线复核：用 rules.json 的 lastPrice，不写文件不推送
node monitor.mjs --offline --price tencent=355 --price hesai=9.5 --no-write   # 压力测试
npm test
```

标的 id：`tencent` `moutai` `popmart` `hesai`。行情源：腾讯财经 → 东方财富 → 雅虎，逐个兜底。

## 日常怎么维护 rules.json

| 事件 | 改哪里 |
|---|---|
| 买入成交 | 对应档 `"filled": true`，并更新 `position.shares` / `avgCost` |
| 禾赛 Q3 财报达标 | `H1b.conditionMet: true`（价格到位时才会发出买入信号） |
| 财报出来，更新 IV | 改 `iv`，**同时**在 `ivHistory` 追加 `{date, iv, reason}`；不一致或没写依据会每天报 `IV_AUDIT` 预警。不允许因为股价跌了就下调 IV |
| 财报 / 月度数据 | 填 L1 的 `value`，或往 `values` 追加一期（series 类按时间从旧到新） |
| 人工判断触发了某条 L1 | 该条 `"triggered": true` → 立即发「逻辑破坏 → 清仓」并压制买入 |
| 泡泡玛特 FY2027 净利确认 ≥HK$130 亿 | `iv: 175`、`ivHistory` 追加，档位改为 105/96/88 |

### L1 判定类型

- `threshold`：单值越线即触发；`warnPct` 内为预警（显示安全垫）
- `series`：最近 `n` 期全部越线才触发（如「连续两季」）；已连续部分期数为预警
- `deadline`：观察期（`deadline`）结束时仍未达标才触发，期内未达标为预警
- `and`：几个子条件同时满足才触发，部分满足为预警
- `manual`：靠人判断（监管、DAU 份额、二手溢价等），新闻命中关键词会提示你去看

状态 `待填数据` 不会报警——但财报后应尽快补上。

## 隐含年化（L3 用）

`(1 + 8%) × (IV / 现价)^(1/3) − 1`：假设 3 年内价格收敛到 IV，叠加 8% 机会成本线。只用于两标的之间比较，不是收益预测。L3 只在「更好标的已触发买入档但现金不够」时才提示换仓评估。

---

所有档位价格都是「到了就做什么」的条件句式，不是对价格的预测。本系统为个人投资纪律工具，不构成投资建议。

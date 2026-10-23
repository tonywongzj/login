// 提醒渠道：按环境变量自动启用，可同时配置多个。未配置任何渠道时只打印到控制台。
//   SERVERCHAN_SENDKEY       Server 酱（微信）
//   BARK_URL                 Bark（iOS），如 https://api.day.app/<key>
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   WECOM_WEBHOOK            企业微信群机器人
//   DINGTALK_WEBHOOK         钉钉群机器人（安全设置用关键词「四标」）
//   FEISHU_WEBHOOK           飞书群机器人
//   NOTIFY_GITHUB_ISSUE=1 + GITHUB_TOKEN + GITHUB_REPOSITORY   开 Issue（GitHub 会发邮件/App 通知）

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
}

export function channels(env = process.env) {
  const list = [];
  if (env.SERVERCHAN_SENDKEY) {
    list.push(['serverchan', (t, b) => post(`https://sctapi.ftqq.com/${env.SERVERCHAN_SENDKEY}.send`, { title: t, desp: b })]);
  }
  if (env.BARK_URL) {
    list.push(['bark', (t, b) => post(env.BARK_URL.replace(/\/$/, ''), { title: t, body: b, group: '四标纪律' })]);
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    list.push(['telegram', (t, b) => post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text: `${t}\n\n${b}` })]);
  }
  if (env.WECOM_WEBHOOK) {
    list.push(['wecom', (t, b) => post(env.WECOM_WEBHOOK, { msgtype: 'markdown', markdown: { content: `**${t}**\n${b}` } })]);
  }
  if (env.DINGTALK_WEBHOOK) {
    list.push(['dingtalk', (t, b) => post(env.DINGTALK_WEBHOOK, { msgtype: 'markdown', markdown: { title: t, text: `### ${t}\n${b}` } })]);
  }
  if (env.FEISHU_WEBHOOK) {
    list.push(['feishu', (t, b) => post(env.FEISHU_WEBHOOK, { msg_type: 'text', content: { text: `${t}\n${b}` } })]);
  }
  if (env.NOTIFY_GITHUB_ISSUE === '1' && env.GITHUB_TOKEN && env.GITHUB_REPOSITORY) {
    list.push(['github-issue', (t, b) => post(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues`, { title: t, body: b, labels: ['四标提醒'] }, {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    })]);
  }
  return list;
}

export async function notify(title, body, { env = process.env, log = console.error } = {}) {
  const list = channels(env);
  log(`\n[notify] ${title}\n${body}\n`);
  const results = [];
  for (const [name, send] of list) {
    try {
      await send(title, body);
      results.push({ name, ok: true });
    } catch (e) {
      log(`[notify] ${name} 失败: ${e.message}`);
      results.push({ name, ok: false, error: e.message });
    }
  }
  return results;
}

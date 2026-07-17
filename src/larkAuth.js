const config = require('./config');

// tenant_access_token 有效期 2 小时，这里做一个进程内缓存（Netlify Function
// 每次冷启动会重置，但同一次调用内 / 短时间热启动内可以复用，减少一次请求）
let cachedToken = null;
let cachedTokenExpireAt = 0;

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpireAt - 60_000) {
    return cachedToken;
  }

  const resp = await fetch(
    `${config.lark.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: config.lark.appId,
        app_secret: config.lark.appSecret,
      }),
    }
  );
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${data.code} ${data.msg}`);
  }

  cachedToken = data.tenant_access_token;
  cachedTokenExpireAt = now + data.expire * 1000;
  return cachedToken;
}

module.exports = { getTenantAccessToken };

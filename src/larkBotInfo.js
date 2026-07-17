const { getTenantAccessToken } = require('./larkAuth');
const config = require('./config');

let cachedBotOpenId = null;

// 获取 bot 自己的 open_id，用于核对消息里的 mentions 确实是 @ 了这个 bot
// （正常情况下，没有"读全部消息"权限时，收到的事件本身就一定是被 @ 触发的，
// 这里多做一层核对是为了防御群里同名/多个 bot 的边界情况）
async function getBotOpenId() {
  if (cachedBotOpenId) return cachedBotOpenId;
  const token = await getTenantAccessToken();
  const resp = await fetch(`${config.lark.apiBaseUrl}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.code !== 0) {
    console.error('获取 bot 信息失败', data);
    return null;
  }
  cachedBotOpenId = data.bot.open_id;
  return cachedBotOpenId;
}

module.exports = { getBotOpenId };

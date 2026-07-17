const { getTenantAccessToken } = require('./larkAuth');
const config = require('./config');

// 原地回复某条消息（会在群里显示为"回复了 XX 的消息"），
// 用来给顾问一个明确的处理结果反馈
async function replyToMessage(messageId, text) {
  const token = await getTenantAccessToken();
  const resp = await fetch(
    `${config.lark.apiBaseUrl}/open-apis/im/v1/messages/${messageId}/reply`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    }
  );
  const data = await resp.json();
  if (data.code !== 0) {
    console.error('回复消息失败', data);
  }
  return data;
}

module.exports = { replyToMessage };

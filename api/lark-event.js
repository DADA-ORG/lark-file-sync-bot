// 配置在飞书/Lark 开发者后台"事件订阅"里的回调 URL：
//   https://<你的项目>.vercel.app/api/lark-event
//
// 必须快速返回（飞书对回调有超时重试机制），所以这里只做：
// 1) URL 校验握手  2) token/签名校验  3) 判断是不是消息事件
// 真正耗时的 LLM/Base/文档处理，转发给 api/process-message.js 异步跑，
// 这里不等它跑完就直接给飞书回 200。

const config = require('../src/config');
const { decryptEventBody } = require('../src/larkCrypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('ok');
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).send('invalid json');
      return;
    }
  }

  // 开启了加密的话，先解密出真正的 payload
  if (body && body.encrypt) {
    try {
      body = decryptEventBody(body.encrypt);
    } catch (e) {
      console.error('解密事件失败', e);
      res.status(400).send('decrypt failed');
      return;
    }
  }

  // 1) URL 校验握手（只在开发者后台第一次配置回调 URL 时会触发一次）
  if (body.type === 'url_verification') {
    res.status(200).json({ challenge: body.challenge });
    return;
  }

  // 2) token 校验（如果配置了 verification token）
  const incomingToken = body.header?.token || body.token;
  if (config.lark.verificationToken && incomingToken !== config.lark.verificationToken) {
    console.error('verification token 不匹配，丢弃该请求');
    res.status(200).send('ok'); // 仍返回 200，避免飞书重试轰炸
    return;
  }

  // 3) 只处理"接收消息"事件
  const eventType = body.header?.event_type;
  if (eventType !== 'im.message.receive_v1') {
    res.status(200).send('ok');
    return;
  }

  // 转发给后台处理函数，不等待它跑完
  fetch(`${config.siteUrl}/api/process-message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': config.internalSecret || '',
    },
    body: JSON.stringify(body),
  }).catch((e) => console.error('触发 process-message 失败', e));

  res.status(200).send('ok');
};

// 实际处理逻辑：LLM 抽取 -> Base 检索匹配 -> 写文档 -> 群内回复。
// 只由 api/lark-event.js 内部调用触发（带 x-internal-secret 头），
// 不是飞书直接调用的地址，也不建议公开暴露。
// vercel.json 里给这个函数配了更长的 maxDuration，允许它比 lark-event 跑更久。

const config = require('../src/config');
const { getBotOpenId } = require('../src/larkBotInfo');
const { fetchAllClients } = require('../src/bitableJobs');
const { extractAndMatch } = require('../src/llmExtract');
const { appendUpdateToDoc } = require('../src/docsWrite');
const { replyToMessage } = require('../src/messageReply');
const { hasProcessed, writeLog } = require('../src/bitableLog');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed');
    return;
  }

  // 校验请求确实来自 api/lark-event.js，不是外部随便 POST 过来的
  if (!config.internalSecret || req.headers['x-internal-secret'] !== config.internalSecret) {
    res.status(401).send('unauthorized');
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const message = body.event?.message;
  if (!message) {
    res.status(200).send('no message');
    return;
  }

  const msgId = message.message_id;
  const chatId = message.chat_id;

  let rawText = '';
  try {
    rawText = JSON.parse(message.content || '{}').text || '';
  } catch (e) {
    rawText = message.content || '';
  }

  try {
    // 幂等：同一条消息（比如飞书重试推送）不重复处理
    if (await hasProcessed(msgId)) {
      console.log(`msg_id=${msgId} 已处理过，跳过`);
      res.status(200).send('duplicate');
      return;
    }

    // 核对确实 @ 了这个 bot（正常情况下能收到事件就已经意味着被 @ 了）
    const botOpenId = await getBotOpenId();
    const mentions = message.mentions || [];
    const mentionedBot = mentions.some((m) => m.id?.open_id === botOpenId);
    if (botOpenId && mentions.length > 0 && !mentionedBot) {
      res.status(200).send('not mentioned');
      return;
    }

    // 把 "@_user_1" 这种占位符从正文里去掉，只保留顾问打的实际内容
    let cleanText = rawText;
    for (const m of mentions) {
      cleanText = cleanText.replace(m.key, '').trim();
    }

    // 抽取 + 匹配（在"客户"这一层匹配，不再纠结具体岗位）
    const clients = await fetchAllClients();
    const result = await extractAndMatch(cleanText, clients);
    const matchedIds = (result.matched_client_ids || []).filter((i) => Number.isInteger(i) && clients[i]);

    // 情况一：没匹配到任何客户
    if (matchedIds.length === 0) {
      await replyToMessage(
        msgId,
        `⚠️ 没能匹配到客户「${result.raw_company_guess || '未知'}」。麻烦确认下客户名称有没有写对，或先把这个客户加进客户表。`
      );
      await writeLog({
        msgId, chatId, rawText: cleanText,
        company: result.raw_company_guess,
        status: 'no_match', detail: JSON.stringify(result),
      });
      res.status(200).send('no match');
      return;
    }

    // 情况二：可能指向多个【不同客户】，无法判断是哪个，让顾问确认
    // （注意：同一个客户名下多个岗位不会走到这里，那只是 1 个客户）
    if (matchedIds.length > 1) {
      const listText = matchedIds
        .map((id, i) => `${i + 1}. ${clients[id].company}`)
        .join('\n');
      await replyToMessage(
        msgId,
        `❓ 识别到可能涉及多个客户，请回复更明确的客户名称重新发一遍：\n${listText}`
      );
      await writeLog({
        msgId, chatId, rawText: cleanText,
        company: result.raw_company_guess,
        status: 'ambiguous', detail: JSON.stringify(result),
      });
      res.status(200).send('ambiguous');
      return;
    }

    // 情况三：唯一客户，写入这个客户的文档
    const matched = clients[matchedIds[0]];
    if (!matched.docRef) {
      await replyToMessage(msgId, `⚠️ 找到了客户「${matched.company}」，但还没给它配更新文档。请在客户表的「Lark Link/Notes」栏补上文档链接后再发一次。`);
      await writeLog({
        msgId, chatId, rawText: cleanText,
        company: matched.company,
        status: 'no_doc_token', detail: JSON.stringify(result),
      });
      res.status(200).send('no doc token');
      return;
    }

    // 如需在更新记录里展示顾问真实姓名，可在此用 body.event.sender.sender_id.open_id
    // 调用通讯录 API（contact:user.base:readonly 权限）查询后拼进摘要文本。
    // 日期标题现在由 docsWrite.js 内部自动生成/分组，这里传客户名（用于兜底路径展示）和更新摘要。
    await appendUpdateToDoc(matched.docRef, matched.company, result.update_summary);

    await replyToMessage(msgId, `✅ 已同步至《${matched.company}》文档`);
    await writeLog({
      msgId, chatId, rawText: cleanText,
      company: matched.company,
      status: 'success', detail: result.update_summary,
    });

    res.status(200).send('ok');
  } catch (err) {
    console.error('处理消息失败', err);
    try {
      await replyToMessage(msgId, `❌ 同步失败：${err.message}，请联系管理员查看日志`);
      await writeLog({ msgId, chatId, rawText, status: 'error', detail: String(err) });
    } catch (e2) {
      console.error('连失败反馈都发不出去', e2);
    }
    res.status(200).send('error handled');
  }
};

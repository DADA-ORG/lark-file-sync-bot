// 把 Lark 消息的 content 解析成纯文本。
//
// ⚠️ 2026-09-06 修的一个大坑：
// 原来 api/process-message.js 里只有一行 `JSON.parse(message.content).text`，
// 那只对 message_type='text'（纯文本）成立。顾问在群里发客户更新时，经常用
// 富文本（post）—— 加粗标题 + 段落 + 项目符号列表。富文本的 content 是
//   { title: "...", content: [ [ {tag:'text',text:'...'}, ... ], ... ] }
// 根本没有 .text 字段 → rawText 变成 ''  → LLM 收到空消息 → 一律回
// 「没能匹配到客户「未知」」。
// 这就是「很多时候顾问在群里更新，bot 都识别不到」的根因：写得越规范
// （分点、加粗）越必然失败。

// post 消息里一个片段 → 文本
function segmentToText(seg) {
  if (!seg || typeof seg !== 'object') return '';
  switch (seg.tag) {
    case 'text':
    case 'code_block':
      return seg.text || '';
    case 'a':
      // 链接：正文用锚文本，地址也留着（客户更新里常贴 JD 链接）
      return seg.href && seg.text && seg.text !== seg.href
        ? `${seg.text}（${seg.href}）`
        : (seg.text || seg.href || '');
    case 'at':
      // @人 / @所有人 —— 对识别客户没用，直接丢掉（原来纯文本分支也是丢掉的）
      return '';
    case 'img':
    case 'media':
    case 'file':
      return '';
    case 'emotion':
      return '';
    case 'hr':
      return '';
    default:
      // 未知 tag 尽量兜底取 text，别整段丢掉
      return seg.text || '';
  }
}

function postNodeToText(node) {
  if (!node || typeof node !== 'object') return '';
  const lines = [];
  if (node.title) lines.push(String(node.title));
  for (const line of node.content || []) {
    if (!Array.isArray(line)) continue;
    lines.push(line.map(segmentToText).join(''));
  }
  // 去掉纯空行，但保留行与行之间的分隔（列表结构对语义有帮助）
  return lines.map((l) => l.trim()).filter(Boolean).join('\n');
}

/**
 * @returns {{ text: string, type: string, supported: boolean }}
 *   supported=false 表示这类消息（图片/文件/语音…）本来就没正文，
 *   调用方应该直接跳过，不要送去 LLM。
 */
function extractMessageText(message) {
  const type = message.message_type || message.msg_type || '';

  let raw;
  try {
    raw = JSON.parse(message.content || '{}');
  } catch (e) {
    // content 不是 JSON 的兜底（理论上不会发生）
    return { text: String(message.content || ''), type: type || 'unknown', supported: true };
  }

  // 1) 纯文本
  if (type === 'text' || typeof raw.text === 'string') {
    return { text: raw.text || '', type: type || 'text', supported: true };
  }

  // 2) 富文本 post。两种形态都收：
  //    新：{ title, content }        旧/多语言：{ zh_cn: {title, content}, en_us: {...} }
  const node = raw.content ? raw : (raw.zh_cn || raw.en_us || raw.ja_jp || null);
  if (node && Array.isArray(node.content)) {
    return { text: postNodeToText(node), type: type || 'post', supported: true };
  }

  // 3) 合并转发（merge_forward）—— 里面是一串子消息，暂不展开，交给调用方跳过
  // 4) 图片 / 文件 / 语音 / 视频 / 表情包 / 卡片：没有可识别的正文
  return { text: '', type: type || 'unknown', supported: false };
}

module.exports = { extractMessageText, postNodeToText, segmentToText };

const { getTenantAccessToken } = require('./larkAuth');
const config = require('./config');

// Lark docx block_type 常量（实测抄自用户的参考文档，不是猜的）：
// 1=Page 2=Text 3=Heading1 5=Heading3 12=Bullet(无序列表)
const BLOCK_TYPE = { PAGE: 1, TEXT: 2, HEADING1: 3, HEADING3: 5 };

function blockPlainText(block) {
  const elements =
    block.text?.elements || block.heading1?.elements || block.heading2?.elements ||
    block.heading3?.elements || [];
  return elements.map((el) => el.text_run?.content || '').join('');
}

// 日期标题格式："2026 July 17th"（英文月份全称 + 序数后缀），按新加坡时区计算"今天"，
// 避免在UTC午夜前后跑批时算错日期。格式和字段命名照抄用户参考文档里手动写的"2026 May 15th"。
function formatDateHeading(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  const day = parseInt(parts.find((p) => p.type === 'day').value, 10);
  const suffix = day >= 11 && day <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
  return `${year} ${month} ${day}${suffix}`;
}

// 拉取文档全部 block（分页），用于定位锚点 block 和根 block
async function listAllBlocks(documentId, token) {
  const blocks = [];
  let pageToken = '';
  do {
    const url = new URL(
      `${config.lark.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks`
    );
    url.searchParams.set('page_size', '500');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    if (data.code !== 0) {
      throw new Error(`拉取文档 blocks 失败: ${data.code} ${data.msg}`);
    }
    blocks.push(...(data.data.items || []));
    pageToken = data.data.has_more ? data.data.page_token : '';
  } while (pageToken);
  return blocks;
}

// Base 里存的可能是 Wiki 节点链接（.../wiki/xxx），不是文档直链。
// Wiki token 不能直接拿去调 docx API，得先用它换出背后真正的 document/obj token。
// 需要应用有 wiki:wiki:readonly（或等效的 Wiki 只读）权限。
async function resolveDocumentId(docRef, token) {
  if (!docRef) return null;
  if (docRef.type === 'docx') return docRef.token;

  if (docRef.type === 'wiki') {
    const url = new URL(`${config.lark.apiBaseUrl}/open-apis/wiki/v2/spaces/get_node`);
    url.searchParams.set('token', docRef.token);
    url.searchParams.set('obj_type', 'wiki');
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (data.code !== 0) {
      throw new Error(`解析 Wiki 节点失败: ${data.code} ${data.msg}（请检查应用是否有 Wiki 只读权限，以及该节点是否已加到知识库里）`);
    }
    const node = data.data.node;
    if (!node) {
      throw new Error('解析 Wiki 节点失败：接口没有返回 node 信息');
    }
    if (node.obj_type !== 'docx') {
      throw new Error(`该 Wiki 节点关联的不是新版文档(docx)，而是「${node.obj_type}」类型，暂不支持自动写入这种类型`);
    }
    return node.obj_token;
  }

  throw new Error(`未知的文档引用类型: ${docRef.type}`);
}

async function createChildren(documentId, parentBlockId, index, children, token) {
  const resp = await fetch(
    `${config.lark.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ children, index }),
    }
  );
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`写入文档失败: ${data.code} ${data.msg}`);
  }
  return data;
}

// 往指定 docRef（{type,token}，见 bitableJobs.js 的 extractDocRef）对应的文档里追加一条更新记录。
// 两层分组结构：日期 -> 岗位 -> 具体更新内容，例：
//   [Heading1] 2026 July 17th                              <- 日期标题，越新的日期排越靠前
//     [Heading3] Public Cloud Technical Support Engineer   <- 岗位标题（同一天内新的岗位排前面）
//       [正文] 岗位需求调整，更倾向产品相关背景...             <- 具体更新内容，普通文字，不是标题
//       [正文] 岗位要求变更：不再需要做产品相关工作            <- 同一天+同一岗位的下一条更新，接在后面
//     [Heading3] Solution Architect                          <- 同一天但不同岗位，另开一个小节
//       [正文] ...
//   [Heading1] 2026 July 16th
//     ...
// 日期标题、岗位标题、更新正文都是"锚点block"的直接子节点（同级，靠顺序体现层级，不互相嵌套）。
// 找不到锚点就退化成在文档根节点【开头】（index=0）加一条纯文本提示+内容，避免更新内容丢失，
// 也让顾问/管理员一打开文档就能看到，不用翻到最后才发现漏配了锚点。
async function appendUpdateToDoc(docRef, positionLabel, text) {
  const token = await getTenantAccessToken();
  const documentId = await resolveDocumentId(docRef, token);
  const blocks = await listAllBlocks(documentId, token);
  const blocksById = new Map(blocks.map((b) => [b.block_id, b]));

  const rootBlock = blocks.find((b) => b.block_type === BLOCK_TYPE.PAGE);
  const anchorBlock = blocks.find((b) =>
    blockPlainText(b).includes(config.doc.anchorBlockText)
  );

  if (!anchorBlock) {
    if (!rootBlock) {
      throw new Error('文档里既没找到锚点 block 也没找到根 block，请检查 document_id 是否正确');
    }
    // 退化路径：没找到锚点，直接插到文档开头（index=0），避免更新内容丢失、也方便被发现
    const fallbackChildren = [
      `⚠️ 未在文档中找到"${config.doc.anchorBlockText}"锚点，以下内容追加在文档开头`,
      `${positionLabel}：${text}`,
    ].map((line) => ({
      block_type: BLOCK_TYPE.TEXT,
      text: { elements: [{ text_run: { content: line } }] },
    }));
    await createChildren(documentId, rootBlock.block_id, 0, fallbackChildren, token);
    return { usedFallback: true };
  }

  const todayStr = formatDateHeading(new Date());
  const dateHeadingBlock = {
    block_type: BLOCK_TYPE.HEADING1,
    heading1: { elements: [{ text_run: { content: todayStr } }] },
  };
  const positionHeadingBlock = {
    block_type: BLOCK_TYPE.HEADING3,
    heading3: {
      elements: [{ text_run: { content: positionLabel, text_element_style: { bold: true } } }],
    },
  };
  // 手动加序号（这些是普通文字block，不是标题，Lark大纲不会像heading那样自动编号）
  const makeTextBlock = (number) => ({
    block_type: BLOCK_TYPE.TEXT,
    text: { elements: [{ text_run: { content: `${number}. ${text}` } }] },
  });

  const childIds = anchorBlock.children || [];
  const firstChild = childIds.length > 0 ? blocksById.get(childIds[0]) : null;
  const firstIsTodayHeading =
    firstChild && firstChild.block_type === BLOCK_TYPE.HEADING1 && blockPlainText(firstChild) === todayStr;

  if (!firstIsTodayHeading) {
    // 新的一天：日期标题 + 岗位标题 + 第一条更新（序号从1开始），一起插到锚点最前面（index=0）
    await createChildren(
      documentId,
      anchorBlock.block_id,
      0,
      [dateHeadingBlock, positionHeadingBlock, makeTextBlock(1)],
      token
    );
    return { usedFallback: false };
  }

  // 今天的日期标题已经在最上面了，先框出"今天"这个区间的范围：
  // 从index=1开始，直到遇到下一个Heading1（新的一天）或者到末尾
  let todayEnd = 1;
  while (todayEnd < childIds.length) {
    const b = blocksById.get(childIds[todayEnd]);
    if (b && b.block_type === BLOCK_TYPE.HEADING1) break;
    todayEnd++;
  }

  // 在今天的区间里找有没有已经存在的同岗位小节（Heading3文字完全匹配）
  let matchIndex = -1;
  for (let i = 1; i < todayEnd; i++) {
    const b = blocksById.get(childIds[i]);
    if (b && b.block_type === BLOCK_TYPE.HEADING3 && blockPlainText(b) === positionLabel) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex === -1) {
    // 今天还没有这个岗位的小节，新建一个（序号从1开始），插在今天日期标题正下面（今天区间最前面）
    await createChildren(documentId, anchorBlock.block_id, 1, [positionHeadingBlock, makeTextBlock(1)], token);
  } else {
    // 已经有这个岗位的小节了，数一下这个小节现有多少条，新的一条接在最后，序号自增
    let insertAt = matchIndex + 1;
    let existingCount = 0;
    while (insertAt < todayEnd) {
      const b = blocksById.get(childIds[insertAt]);
      if (b && b.block_type === BLOCK_TYPE.TEXT) {
        insertAt++;
        existingCount++;
      } else {
        break;
      }
    }
    await createChildren(documentId, anchorBlock.block_id, insertAt, [makeTextBlock(existingCount + 1)], token);
  }

  return { usedFallback: false };
}

module.exports = { appendUpdateToDoc, resolveDocumentId, listAllBlocks, blockPlainText };

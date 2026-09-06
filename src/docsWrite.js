const { getTenantAccessToken } = require('./larkAuth');
const config = require('./config');

// Lark docx block_type 常量（实测抄自用户的参考文档，不是猜的）：
// 1=Page 2=Text 3=Heading1 5=Heading3 12=Bullet(无序列表)
const BLOCK_TYPE = { PAGE: 1, TEXT: 2, HEADING1: 3, HEADING3: 5 };

// Lark 云文档常见错误码 → 顾问看得懂的话 + 具体怎么修。
// 1770032 forBidden 是最常见的一个：应用本身有 docx:document 权限，但【这一份文档】
// 没有把 bot 加成协作者。注意它有两种表现：
//   - 拉取 blocks 就失败 → bot 连读都读不了
//   - 能读、写的时候才失败 → bot 只有只读权限（常见于只从知识库继承了只读）
const DOC_PERM_CODES = new Set([1770032, 1254302, 1254043, 99991672, 99991671]);
function friendlyDocError(action, code, msg, docRef) {
  const where = docRef ? `（${docRef.type}: ${docRef.token}）` : '';
  if (DOC_PERM_CODES.has(Number(code))) {
    return `bot 打不开这份客户文档${where} —— 没被加成这个文档的协作者。`
      + `请打开该文档 →「···」→「添加文档应用」→ 加上「Group- File Sync Bot」并给【可编辑】权限。`
      + `（原始错误 ${code} ${msg}）`;
  }
  return `${action}失败: ${code} ${msg}${where}`;
}

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
async function listAllBlocks(documentId, token, docRef) {
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
      throw new Error(friendlyDocError('拉取文档内容', data.code, data.msg, docRef));
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

async function createChildren(documentId, parentBlockId, index, children, token, docRef) {
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
    throw new Error(friendlyDocError('写入文档', data.code, data.msg, docRef));
  }
  return data;
}

// 往指定 docRef（{type,token}，见 bitableJobs.js 的 extractDocRef）对应的文档里追加一条更新记录。
// 一个文档 = 一个客户（用户 2026-07 确认的用法），所以按【日期】一层分组即可，不再分岗位小节：
//   [Heading1] 2026 July 17th          <- 日期标题，越新的日期排越靠前
//     [正文] 1. 客户说下周二面，两个岗位都在推进...   <- 当天第 1 条更新（普通文字，手动编号）
//     [正文] 2. 整理了客户资料，大家参考...          <- 当天第 2 条更新，接在后面
//   [Heading1] 2026 July 16th
//     [正文] 1. ...
// 日期标题和更新正文都是"锚点block"的直接子节点（同级，靠顺序体现层级，不互相嵌套）。
// 找不到锚点就退化成在文档根节点【开头】（index=0）加一条纯文本提示+内容，避免更新内容丢失，
// 也让顾问/管理员一打开文档就能看到，不用翻到最后才发现漏配了锚点。
// clientLabel 只用于兜底路径（没锚点时）在提示里标明是哪个客户，正常路径不写它。
async function appendUpdateToDoc(docRef, clientLabel, text) {
  const token = await getTenantAccessToken();
  const documentId = await resolveDocumentId(docRef, token);
  const blocks = await listAllBlocks(documentId, token, docRef);
  const blocksById = new Map(blocks.map((b) => [b.block_id, b]));

  const rootBlock = blocks.find((b) => b.block_type === BLOCK_TYPE.PAGE);
  const anchorBlock = blocks.find((b) =>
    blockPlainText(b).includes(config.doc.anchorBlockText)
  );

  const todayStr = formatDateHeading(new Date());
  const dateHeadingBlock = {
    block_type: BLOCK_TYPE.HEADING1,
    heading1: { elements: [{ text_run: { content: todayStr } }] },
  };
  // 手动加序号（这些是普通文字block，不是标题，Lark大纲不会像heading那样自动编号）
  const makeTextBlock = (number) => ({
    block_type: BLOCK_TYPE.TEXT,
    text: { elements: [{ text_run: { content: `${number}. ${text}` } }] },
  });

  // 文档里还没有锚点标题：自动在文档顶部建一个「Updates（AI总结）」标题，再把它当锚点往下写。
  // 这样任何客户文档第一次被写时会自动成型，不需要有人手动去每个文档预先放锚点，
  // 顾问那边也永远不会看到"未找到锚点"这种看不懂的提示。
  if (!anchorBlock) {
    if (!rootBlock) {
      throw new Error('文档里既没找到锚点也没找到根节点，请检查 document_id 是否正确');
    }
    const anchorHeadingBlock = {
      block_type: BLOCK_TYPE.HEADING1,
      heading1: { elements: [{ text_run: { content: config.doc.anchorBlockText } }] },
    };
    const created = await createChildren(documentId, rootBlock.block_id, 0, [anchorHeadingBlock], token, docRef);
    const newAnchorId = created.data.children[0].block_id;
    // 新锚点下面还没有任何内容，直接放"今天日期标题 + 第一条更新"
    await createChildren(documentId, newAnchorId, 0, [dateHeadingBlock, makeTextBlock(1)], token, docRef);
    return { usedFallback: false };
  }

  const childIds = anchorBlock.children || [];
  const firstChild = childIds.length > 0 ? blocksById.get(childIds[0]) : null;
  const firstIsTodayHeading =
    firstChild && firstChild.block_type === BLOCK_TYPE.HEADING1 && blockPlainText(firstChild) === todayStr;

  if (!firstIsTodayHeading) {
    // 新的一天：日期标题 + 第一条更新（序号从1开始），一起插到锚点最前面（index=0）
    await createChildren(
      documentId,
      anchorBlock.block_id,
      0,
      [dateHeadingBlock, makeTextBlock(1)],
      token,
      docRef
    );
    return { usedFallback: false };
  }

  // 今天的日期标题已经在最上面（index=0）了。从 index=1 开始数今天已有多少条更新正文，
  // 直到遇到下一个日期标题（Heading1，即前一天的区块）或到末尾，新的一条接在最后、序号自增。
  let insertAt = 1;
  let existingCount = 0;
  while (insertAt < childIds.length) {
    const b = blocksById.get(childIds[insertAt]);
    if (b && b.block_type === BLOCK_TYPE.TEXT) {
      insertAt++;
      existingCount++;
    } else {
      break; // 遇到下一个日期标题（或其它非正文块），今天的区间到此为止
    }
  }
  await createChildren(documentId, anchorBlock.block_id, insertAt, [makeTextBlock(existingCount + 1)], token, docRef);

  return { usedFallback: false };
}

module.exports = { appendUpdateToDoc, resolveDocumentId, listAllBlocks, blockPlainText, friendlyDocError };

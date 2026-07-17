const { getTenantAccessToken } = require('./larkAuth');
const config = require('./config');

function blockPlainText(block) {
  const elements =
    block.text?.elements || block.heading1?.elements || block.heading2?.elements ||
    block.heading3?.elements || [];
  return elements.map((el) => el.text_run?.content || '').join('');
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

// 往指定 documentId 里追加一条更新记录文本。
// 优先找模板里预留的"群内更新记录"锚点标题 block，插到它下面（作为它的子 block，追加在末尾）；
// 找不到锚点就退而求其次，直接追加到文档根节点末尾，并加一句提示，避免更新内容丢失。
async function appendUpdateToDoc(documentId, text) {
  const token = await getTenantAccessToken();
  const blocks = await listAllBlocks(documentId, token);

  const rootBlock = blocks.find((b) => b.block_type === 1); // Page/root block
  const anchorBlock = blocks.find((b) =>
    blockPlainText(b).includes(config.doc.anchorBlockText)
  );

  let parentBlockId;
  let usedFallback = false;
  if (anchorBlock) {
    parentBlockId = anchorBlock.block_id;
  } else if (rootBlock) {
    parentBlockId = rootBlock.block_id;
    usedFallback = true;
  } else {
    throw new Error('文档里既没找到锚点 block 也没找到根 block，请检查 document_id 是否正确');
  }

  // 数一下目标父节点当前有多少个子节点，用来把新内容插到最后
  const childrenCount = blocks.filter((b) => b.parent_id === parentBlockId).length;

  const contentLines = usedFallback
    ? [`⚠️ 未在文档中找到"${config.doc.anchorBlockText}"锚点，以下内容追加在文档末尾`, text]
    : [text];

  const children = contentLines.map((line) => ({
    block_type: 2, // text 段落
    text: { elements: [{ text_run: { content: line } }] },
  }));

  const resp = await fetch(
    `${config.lark.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ children, index: childrenCount }),
    }
  );
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`写入文档失败: ${data.code} ${data.msg}`);
  }
  return { usedFallback };
}

module.exports = { appendUpdateToDoc };

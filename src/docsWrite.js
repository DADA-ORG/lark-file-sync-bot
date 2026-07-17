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

// 往指定 docRef（{type,token}，见 bitableJobs.js 的 extractDocRef）对应的文档里追加一条更新记录文本。
// 优先找模板里预留的"群内更新记录"锚点标题 block，插到它下面（作为它的子 block，追加在末尾）；
// 找不到锚点就退而求其次，直接追加到文档根节点末尾，并加一句提示，避免更新内容丢失。
async function appendUpdateToDoc(docRef, text) {
  const token = await getTenantAccessToken();
  const documentId = await resolveDocumentId(docRef, token);
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

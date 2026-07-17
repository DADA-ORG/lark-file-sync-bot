// 一次性只读脚本：检查 AIPULSE - Public Cloud Technical Support Engineer 这份文档里
// 是否已经有 DOC_ANCHOR_BLOCK_TEXT（默认 "Updates（AI总结）"）这个锚点标题。
// 不会修改文档内容，纯读取确认。
//
// 用法：
//   LARK_APP_ID=cli_aad23ce453399ee9 \
//   LARK_APP_SECRET=你的secret \
//   node check-anchor.js

process.env.LARK_API_BASE_URL = process.env.LARK_API_BASE_URL || 'https://open.larksuite.com';

const config = require('./src/config');
const { getTenantAccessToken } = require('./src/larkAuth');
const { resolveDocumentId, listAllBlocks, blockPlainText } = require('./src/docsWrite');

// 来自 debug-jobs 接口的 docRef：AIPULSE - Public Cloud Technical Support Engineer
const DOC_REF = { type: 'wiki', token: 'H1TTwmTiOiAyggkeBnmlHpXOgPf' };

async function main() {
  console.log('当前配置的锚点文字 DOC_ANCHOR_BLOCK_TEXT =', JSON.stringify(config.doc.anchorBlockText));

  const token = await getTenantAccessToken();
  const documentId = await resolveDocumentId(DOC_REF, token);
  console.log('documentId =', documentId);

  const blocks = await listAllBlocks(documentId, token);
  console.log(`共 ${blocks.length} 个block\n`);

  console.log('=== 所有标题类block（block_type 3/4/5，方便看有没有现成的锚点候选）===');
  for (const b of blocks) {
    if ([3, 4, 5].includes(b.block_type)) {
      console.log(`  block_type=${b.block_type} plain_text=${JSON.stringify(blockPlainText(b))} block_id=${b.block_id}`);
    }
  }

  const anchorBlock = blocks.find((b) => blockPlainText(b).includes(config.doc.anchorBlockText));
  console.log('\n找到锚点了吗？', anchorBlock ? '是' : '否');
  if (anchorBlock) {
    console.log('锚点 block_id =', anchorBlock.block_id, ' block_type =', anchorBlock.block_type);
    console.log('锚点现有 children =', JSON.stringify(anchorBlock.children || []));
  }
}

main().catch((err) => {
  console.error('脚本出错：', err.message);
  process.exit(1);
});

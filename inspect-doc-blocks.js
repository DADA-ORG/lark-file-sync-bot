// 一次性只读脚本：把 AIPULSE - Public Cloud Technical Support Engineer 这份文档的全部block
// 原样打印出来，用来看清楚"日期标题 + 编号列表"这种手动排好的格式，实际用的block_type/字段名是什么，
// 好照着写代码，不瞎猜block_type数字。不会修改文档任何内容。
//
// 用法（在项目根目录 lark-file-sync-bot/ 下）：
//   LARK_APP_ID=cli_aad23ce453399ee9 \
//   LARK_APP_SECRET=你的secret \
//   node inspect-doc-blocks.js

process.env.LARK_API_BASE_URL = process.env.LARK_API_BASE_URL || 'https://open.larksuite.com';

const { getTenantAccessToken } = require('./src/larkAuth');
const { resolveDocumentId, listAllBlocks, blockPlainText } = require('./src/docsWrite');

// 用户指定的参考文档（格式示例来源）
const DOC_REF = { type: 'wiki', token: 'SJoXwVoMxi8vlRkiqMOlMKoHg5c' };

async function main() {
  const token = await getTenantAccessToken();
  const documentId = await resolveDocumentId(DOC_REF, token);
  console.log('documentId =', documentId);

  const blocks = await listAllBlocks(documentId, token);
  console.log(`共 ${blocks.length} 个block\n`);

  for (const b of blocks) {
    console.log('----');
    console.log('block_id     =', b.block_id);
    console.log('parent_id    =', b.parent_id);
    console.log('block_type   =', b.block_type);
    console.log('children     =', JSON.stringify(b.children || []));
    console.log('plain_text   =', JSON.stringify(blockPlainText(b)));
    console.log('raw          =', JSON.stringify(b));
  }
}

main().catch((err) => {
  console.error('脚本出错：', err.message);
  process.exit(1);
});

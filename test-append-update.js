// 一次性测试脚本：往 AIPULSE - Public Cloud Technical Support Engineer 这份真实文档里
// 连续写两条测试更新，模拟"同一天两条更新"的场景，验证：
//   1) 第一条：新建 今天日期(Heading1) + 更新1(Heading3)
//   2) 第二条：不重复日期，直接在今天这组下面追加 更新2(Heading3)
// 写完会把最新的block结构打印出来，方便核对。测试内容标了[TEST]前缀，方便你之后手动删掉。
//
// 用法：
//   LARK_APP_ID=cli_aad23ce453399ee9 \
//   LARK_APP_SECRET=你的secret \
//   node test-append-update.js

process.env.LARK_API_BASE_URL = process.env.LARK_API_BASE_URL || 'https://open.larksuite.com';

const { getTenantAccessToken } = require('./src/larkAuth');
const { appendUpdateToDoc, resolveDocumentId, listAllBlocks, blockPlainText } = require('./src/docsWrite');

const DOC_REF = { type: 'wiki', token: 'H1TTwmTiOiAyggkeBnmlHpXOgPf' };

async function dumpAnchorArea() {
  const token = await getTenantAccessToken();
  const documentId = await resolveDocumentId(DOC_REF, token);
  const blocks = await listAllBlocks(documentId, token);
  const blocksById = new Map(blocks.map((b) => [b.block_id, b]));
  const anchor = blocks.find((b) => blockPlainText(b).includes('Updates'));
  console.log('\n=== 锚点下面现在的结构 ===');
  for (const id of anchor.children || []) {
    const b = blocksById.get(id);
    console.log(`  [block_type=${b.block_type}] ${JSON.stringify(blockPlainText(b))}`);
  }
}

async function main() {
  console.log('写第1条...');
  const r1 = await appendUpdateToDoc(DOC_REF, '[TEST] 客户说明天约面试（第1条测试更新）');
  console.log('结果:', r1);

  console.log('\n写第2条（同一天）...');
  const r2 = await appendUpdateToDoc(DOC_REF, '[TEST] 候选人已确认到岗时间（第2条测试更新）');
  console.log('结果:', r2);

  await dumpAnchorArea();
}

main().catch((err) => {
  console.error('脚本出错：', err.message);
  process.exit(1);
});

// 一次性测试脚本（更新版，两层分组：日期 -> 岗位）：往 AIPULSE 这份真实文档里写测试更新，验证：
//   1) 第1条（新岗位A）：新建 今天日期(H1) + 岗位A标题(H3) + 更新正文
//   2) 第2条（同一天，同岗位A）：不重复日期和岗位标题，直接接一行正文到岗位A小节下面
//   3) 第3条（同一天，不同岗位B）：不重复日期，但新开一个岗位B小节
// 写完打印最新block结构核对。测试内容标了[TEST]前缀，方便之后手动删。
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
  console.log('写第1条（岗位A，新建小节）...');
  const r1 = await appendUpdateToDoc(
    DOC_REF,
    '[TEST] Public Cloud Technical Support Engineer',
    '[TEST内容] 岗位需求调整，更倾向产品相关背景'
  );
  console.log('结果:', r1);

  console.log('\n写第2条（岗位A，同一天，应该接在同一小节下面）...');
  const r2 = await appendUpdateToDoc(
    DOC_REF,
    '[TEST] Public Cloud Technical Support Engineer',
    '[TEST内容] 仍需具备运营经验、技术能力和落地能力'
  );
  console.log('结果:', r2);

  console.log('\n写第3条（岗位B，同一天，应该新开一个岗位小节）...');
  const r3 = await appendUpdateToDoc(
    DOC_REF,
    '[TEST] Solution Architect',
    '[TEST内容] 客户希望尽快安排面试'
  );
  console.log('结果:', r3);

  await dumpAnchorArea();
}

main().catch((err) => {
  console.error('脚本出错：', err.message);
  process.exit(1);
});

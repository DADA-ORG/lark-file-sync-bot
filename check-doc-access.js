#!/usr/bin/env node
// 体检脚本：把客户表里每一个客户的文档过一遍，报告 bot 到底能不能读、能不能写。
//
//   node check-doc-access.js            # 打印报告
//   node check-doc-access.js --csv      # 顺便导出 doc-access-report.csv
//
// 只读操作，不会往任何客户文档里写东西。
//
// 为什么需要它：群里报的错分两种 ——
//   ⚠️ 没能匹配到客户「未知」     → 消息正文没解析出来（已修，见 src/messageText.js）
//   ❌ 1770032 forBidden          → 客户名匹配上了，但 bot 打不开那份文档
// 第二种是逐个文档的权限问题，只能一个个查。这个脚本就是把「一个个查」自动化。
//
// 跑之前要有环境变量（跟 Vercel 上那套一样）：
//   LARK_APP_ID / LARK_APP_SECRET / BASE_APP_TOKEN / BASE_JOBS_TABLE_ID
// 本地可以放进 .env 然后 `node --env-file=.env check-doc-access.js`

const config = require('./src/config');
const { getTenantAccessToken } = require('./src/larkAuth');
const { fetchAllClients } = require('./src/bitableJobs');
const { resolveDocumentId } = require('./src/docsWrite');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 Lark 的「判断当前身份有没有某权限」接口，不用真的去写，避免污染客户文档
async function checkPerm(token, docToken, action) {
  const url = new URL(`${config.lark.apiBaseUrl}/open-apis/drive/v1/permissions/${docToken}/members/auth`);
  url.searchParams.set('type', 'docx');
  url.searchParams.set('action', action); // view / edit
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  if (data.code !== 0) return { ok: false, err: `${data.code} ${data.msg}` };
  return { ok: !!data.data?.auth_result };
}

// 兜底：真的去拉一次 blocks，确认"读"这条路走不走得通
async function canListBlocks(token, documentId) {
  const url = new URL(`${config.lark.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks`);
  url.searchParams.set('page_size', '1');
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  return data.code === 0 ? { ok: true } : { ok: false, err: `${data.code} ${data.msg}` };
}

(async () => {
  const missing = ['LARK_APP_ID', 'LARK_APP_SECRET', 'BASE_APP_TOKEN', 'BASE_JOBS_TABLE_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌ 缺环境变量：${missing.join(', ')}`);
    console.error('   去 Vercel → lark-file-sync-bot → Settings → Environment Variables 复制出来，');
    console.error('   存成本地 .env，然后跑：node --env-file=.env check-doc-access.js');
    process.exit(1);
  }

  const token = await getTenantAccessToken();
  const clients = await fetchAllClients();
  console.log(`客户表里共 ${clients.length} 个客户\n`);

  const rows = [];
  for (const c of clients) {
    const row = { company: c.company, positions: (c.positions || []).length, docRef: '', status: '', detail: '' };

    if (!c.docRef) {
      row.status = '❌ 没填文档链接';
      row.detail = '客户表「Lark Link/Notes」列是空的 → bot 会回「还没配更新文档」';
      rows.push(row); continue;
    }
    row.docRef = `${c.docRef.type}:${c.docRef.token}`;

    let documentId;
    try {
      documentId = await resolveDocumentId(c.docRef, token);
    } catch (e) {
      row.status = '❌ 文档链接解析不了';
      row.detail = e.message;
      rows.push(row); continue;
    }

    const read = await canListBlocks(token, documentId);
    if (!read.ok) {
      row.status = '❌ 读不了';
      row.detail = `bot 连打开都打不开：${read.err}`;
      rows.push(row); await sleep(120); continue;
    }

    const edit = await checkPerm(token, documentId, 'edit');
    if (edit.ok === false && edit.err) {
      row.status = '⚠️ 读得了，写权限查不到';
      row.detail = `权限接口报错：${edit.err}（多半仍是只读，建议手动确认）`;
    } else if (!edit.ok) {
      row.status = '⚠️ 只读，写不了';
      row.detail = 'bot 能打开但不能写 → 会报「写入文档失败 1770032」';
    } else {
      row.status = '✅ 可读可写';
    }
    rows.push(row);
    await sleep(120);
  }

  const by = (s) => rows.filter((r) => r.status.startsWith(s));
  const ok = by('✅'); const ro = by('⚠️'); const bad = by('❌');

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('状态', 20) + pad('客户', 28) + '说明');
  console.log('-'.repeat(110));
  for (const r of [...bad, ...ro, ...ok]) {
    console.log(pad(r.status, 18) + pad(r.company.slice(0, 24), 28) + r.detail);
  }

  console.log('\n' + '='.repeat(110));
  console.log(`✅ 可读可写 ${ok.length}　⚠️ 只读/存疑 ${ro.length}　❌ 完全不通 ${bad.length}　（共 ${rows.length}）`);
  if (ro.length + bad.length) {
    console.log('\n修法：打开对应客户文档 →「···」→「添加文档应用」→ 加「Group- File Sync Bot」并给【可编辑】。');
    console.log('　　　「没填文档链接」那种是数据问题，去客户表的「Lark Link/Notes」列补链接。');
  }

  if (process.argv.includes('--csv')) {
    const { writeFileSync } = require('node:fs');
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = ['状态,客户,岗位数,文档,说明']
      .concat(rows.map((r) => [r.status, r.company, r.positions, r.docRef, r.detail].map(esc).join(',')))
      .join('\n');
    writeFileSync('doc-access-report.csv', '﻿' + csv);
    console.log('\n→ doc-access-report.csv');
  }
})().catch((e) => { console.error(e); process.exit(1); });

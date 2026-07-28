const { getTenantAccessToken } = require('./larkAuth');
const { getBaseAppToken } = require('./resolveBaseAppToken');
const config = require('./config');

// "关联文档" 字段在 Base 里可能是几种类型，这里都兼容一下：
// 1) 纯文本字段，直接填文档 URL 或 document_id（最简单可靠）
// 2) Base 原生的"文档"字段类型，返回结构是 [{ file_token, name, type, url }]
// 3) "超链接"字段类型（比如测试表里叫 "Lark Link/Notes" 那一列），返回结构是 { link, text }
//
// 注意：链接可能指向两种不同体系的地址——
//   - 新版文档直链：.../docx/<document_id>，可以直接拿 document_id 用 docx API 读写
//   - Wiki 节点链接：.../wiki/<wiki_token>，这个 token 不是 document_id，
//     背后可能包着 docx/sheet/bitable 等任意类型的内容，必须先调
//     /open-apis/wiki/v2/spaces/get_node 用 wiki_token 换出真正的 obj_token
//     （这一步在 docsWrite.js 的 resolveDocumentId 里做）。
// 这里统一返回 { type: 'docx' | 'wiki', token } 这种带类型标记的引用，
// 而不是直接返回一个裸 token 字符串，避免把两种体系的 id 搞混。
function extractDocRef(rawValue) {
  if (!rawValue) return null;

  const extractRef = (url) => {
    let match = url.match(/wiki\/([a-zA-Z0-9]+)/);
    if (match) return { type: 'wiki', token: match[1] };
    match = url.match(/docx\/([a-zA-Z0-9]+)/);
    if (match) return { type: 'docx', token: match[1] };
    return null;
  };

  if (typeof rawValue === 'string') {
    return extractRef(rawValue) || (rawValue.trim() ? { type: 'docx', token: rawValue.trim() } : null);
  }
  if (Array.isArray(rawValue) && rawValue[0]) {
    if (rawValue[0].file_token) return { type: 'docx', token: rawValue[0].file_token };
    if (rawValue[0].url) return extractRef(rawValue[0].url);
  }
  if (typeof rawValue === 'object' && rawValue.link) {
    return extractRef(rawValue.link);
  }
  return null;
}

// 拉取岗位信息表里的全部记录（分页），返回简化后的结构，
// 后面既要传给 LLM 做匹配，也要在匹配到之后拿 docToken 去写文档
async function fetchAllJobs() {
  const token = await getTenantAccessToken();
  const appToken = await getBaseAppToken();
  const { fields } = config.base;
  const records = [];
  let pageToken = '';

  do {
    const url = new URL(
      `${config.lark.apiBaseUrl}/open-apis/bitable/v1/apps/${appToken}/tables/${config.base.jobsTableId}/records`
    );
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    if (data.code !== 0) {
      throw new Error(`拉取岗位表失败: ${data.code} ${data.msg}`);
    }

    for (const item of data.data.items || []) {
      records.push({
        recordId: item.record_id,
        company: item.fields[fields.company] || '',
        position: item.fields[fields.position] || '',
        alias: item.fields[fields.alias] || '',
        docRef: extractDocRef(item.fields[fields.docToken]),
      });
    }
    pageToken = data.data.has_more ? data.data.page_token : '';
  } while (pageToken);

  return records;
}

// 按「客户」归拢岗位记录。业务事实（用户 2026-07 确认）：顾问是按客户整体做更新的，
// 而不是分岗位更新；而且同一个客户名下的多个岗位行，在 Base 里共用同一个关联文档。
// 所以匹配应该在"客户"这一层做，而不是"岗位"层——一个客户有 5 个岗位时，不该再
// 因为对不上具体哪个岗位而报"多条待确认"，它们指向的是同一个文档。
//
// 返回结构：每个客户一条，带上它的文档引用（取该客户名下第一条填了文档的岗位行的引用，
// 因为同客户共用同一个文档，取哪条都一样）和它名下的岗位名列表（仅用于喂给 LLM 做语义
// 参考，帮助模型确认"这条更新确实是这个客户的"，不参与最终写哪个文档的决策）。
async function fetchAllClients() {
  const jobs = await fetchAllJobs();
  // 用"去空格 + 忽略大小写"后的客户名作为归拢 key。实测（2026-07 用户 Base）里存在
  // 同一客户大小写不一致被拆成两条的情况（例如 Huawei / HuaWei、Alicloud / AliCloud），
  // 而且往往只有其中一种写法填了文档。按规范化 key 合并能把它们并成一个客户，
  // 顺带把有文档的那一份的文档引用捡回来，避免误报"涉及多个客户"或写到没文档的那份。
  const byKey = new Map();

  for (const job of jobs) {
    const company = (job.company || '').trim();
    if (!company) continue; // 没填客户名的行跳过，无法归类
    const key = company.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, { docRef: null, positions: [], nameCounts: new Map() });
    }
    const entry = byKey.get(key);
    // 记录各种大小写写法出现的次数，最后用出现最多的那种作为展示名
    entry.nameCounts.set(company, (entry.nameCounts.get(company) || 0) + 1);
    if (job.position) entry.positions.push(job.position);
    // 取第一个非空的文档引用作为这个客户的文档（同客户共用同一个文档）
    if (!entry.docRef && job.docRef) entry.docRef = job.docRef;
  }

  return Array.from(byKey.values()).map((entry) => ({
    company: [...entry.nameCounts.entries()].sort((a, b) => b[1] - a[1])[0][0],
    docRef: entry.docRef,
    positions: entry.positions,
  }));
}

module.exports = { fetchAllJobs, fetchAllClients };

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

  // Lark 云文档的 URL 形态比原来写的两种多。实测踩过：
  //   /wiki/<token>            知识库节点（要再换一次 obj_token，见 docsWrite.resolveDocumentId）
  //   /docx/<token>            新版文档
  //   /docs/<token>            旧版文档（原代码不认，会被当成"不是链接"）
  //   /wiki/space/... ?node=   知识库里带 node 参数的形态
  //   /record/<token>          ⚠️ 多维表格【记录】链接，不是文档（AIPULSE 就贴错成这个）
  //   /base/ /sheets/ /file/   ⚠️ 也都不是文档
  const extractRef = (url) => {
    const s = String(url);
    // 先看有没有显式的 node 参数（知识库分享出来的链接常带）
    let match = s.match(/[?&]node[_-]?token=([A-Za-z0-9]{10,})/i);
    if (match) return { type: 'wiki', token: match[1] };
    match = s.match(/\/wiki\/(?!space\/)([A-Za-z0-9]{10,})/);
    if (match) return { type: 'wiki', token: match[1] };
    match = s.match(/\/(?:docx|docs|doc)\/([A-Za-z0-9]{10,})/);
    if (match) return { type: 'docx', token: match[1] };
    return null;
  };

  // 贴成了别的东西（记录/表格/文件…）时，告诉顾问他贴的到底是什么
  const WRONG_KIND = {
    record: '多维表格的【记录】链接', base: '多维表格链接', sheets: '电子表格链接',
    sheet: '电子表格链接', file: '文件链接', drive: '云盘链接', minutes: '妙记链接',
  };
  const wrongKindOf = (url) => {
    const m = String(url).match(/larksuite\.com\/([a-z]+)\//i) || String(url).match(/\/([a-z]+)\/[A-Za-z0-9]{10,}/);
    return m ? WRONG_KIND[m[1].toLowerCase()] : null;
  };

  // 裸 token 长这样：一串 20~30 位的字母数字，没有空格、没有标点。
  // 「OKX Updates」「[Update] Metabit」这种是文档标题，不是 token，不能硬当 token 用。
  const looksLikeToken = (s) => /^[A-Za-z0-9]{16,40}$/.test(s);

  // 填了内容但不是可用的文档链接（比如贴成了 /record/ 的 Bitable 记录链接，
  // 或者只写了文档标题）。返回 invalid 而不是 null，好让上层区分
  //「压根没填」和「填了但填错了」—— 这两种给顾问的提示完全不一样。
  // ⚠️ raw 会被拼进群消息里。如果原样带着 https:// 发出去，Lark 会把它渲染成
  //    「📄 文档标题」的卡片，反而看不见真实链接长什么样 —— 排查时最需要的信息就没了。
  //    所以这里把协议头和域名去掉，只留路径（/xxx/yyyy），Lark 不会去展开它。
  const invalid = (raw) => {
    const s = String(raw).slice(0, 200);
    const path = s.replace(/^https?:\/\/[^/]+/i, '') || s;
    return { type: 'invalid', raw: path, kind: wrongKindOf(s) };
  };

  if (typeof rawValue === 'string') {
    const s = rawValue.trim();
    if (!s) return null;
    return extractRef(s) || (looksLikeToken(s) ? { type: 'docx', token: s } : invalid(s));
  }
  if (Array.isArray(rawValue) && rawValue[0]) {
    if (rawValue[0].file_token) return { type: 'docx', token: rawValue[0].file_token };
    if (rawValue[0].url) return extractRef(rawValue[0].url) || invalid(rawValue[0].url);
    if (rawValue[0].text) return extractDocRef(rawValue[0].text);
  }
  if (typeof rawValue === 'object' && rawValue.link) {
    return extractRef(rawValue.link) || invalid(rawValue.link);
  }
  if (typeof rawValue === 'object' && rawValue.text) {
    return extractDocRef(rawValue.text);
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
    // 取第一个【可用】的文档引用作为这个客户的文档（同客户共用同一个文档）。
    // 同一客户下如果有的行填对了、有的行填错了(invalid)，要优先用填对的那条。
    if (job.docRef && (!entry.docRef || (entry.docRef.type === 'invalid' && job.docRef.type !== 'invalid'))) {
      entry.docRef = job.docRef;
    }
  }

  return Array.from(byKey.values()).map((entry) => ({
    company: [...entry.nameCounts.entries()].sort((a, b) => b[1] - a[1])[0][0],
    docRef: entry.docRef,
    positions: entry.positions,
  }));
}

module.exports = { fetchAllJobs, fetchAllClients };

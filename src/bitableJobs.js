const { getTenantAccessToken } = require('./larkAuth');
const config = require('./config');

// "关联文档" 字段在 Base 里可能是几种类型，这里都兼容一下：
// 1) 纯文本字段，直接填文档 URL 或 document_id（最简单可靠）
// 2) Base 原生的"文档"字段类型，返回结构是 [{ file_token, name, type, url }]
// 3) "超链接"字段类型（比如测试表里叫 "Lark Link/Notes" 那一列），返回结构是 { link, text }
function extractDocToken(rawValue) {
  if (!rawValue) return '';

  const extractFromUrl = (url) => {
    const match = url.match(/docx\/([a-zA-Z0-9]+)/);
    return match ? match[1] : '';
  };

  if (typeof rawValue === 'string') {
    return extractFromUrl(rawValue) || rawValue.trim();
  }
  if (Array.isArray(rawValue) && rawValue[0]) {
    if (rawValue[0].file_token) return rawValue[0].file_token;
    if (rawValue[0].url) return extractFromUrl(rawValue[0].url) || '';
  }
  if (typeof rawValue === 'object' && rawValue.link) {
    return extractFromUrl(rawValue.link) || '';
  }
  return '';
}

// 拉取岗位信息表里的全部记录（分页），返回简化后的结构，
// 后面既要传给 LLM 做匹配，也要在匹配到之后拿 docToken 去写文档
async function fetchAllJobs() {
  const token = await getTenantAccessToken();
  const { fields } = config.base;
  const records = [];
  let pageToken = '';

  do {
    const url = new URL(
      `${config.lark.apiBaseUrl}/open-apis/bitable/v1/apps/${config.base.appToken}/tables/${config.base.jobsTableId}/records`
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
        docToken: extractDocToken(item.fields[fields.docToken]),
      });
    }
    pageToken = data.data.has_more ? data.data.page_token : '';
  } while (pageToken);

  return records;
}

module.exports = { fetchAllJobs };

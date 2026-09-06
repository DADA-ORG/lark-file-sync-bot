const config = require('./config');

// 用一次 LLM 调用同时完成"抽取"和"匹配"：
// 把群消息原文 + 客户候选列表（每个客户 + 它名下的岗位，供语义参考）都喂给模型，
// 让模型直接判断这条更新对应哪一个客户 / 哪几个 / 一个都不对应。
// 关键设计（2026-07 用户确认）：顾问是按【客户】整体做更新的，不是分岗位；而且同一
// 客户名下的多个岗位共用同一个文档。所以匹配就在"客户"这一层做——同客户挂 5 个岗位
// 也只是一个候选，不会再出现"识别到多条岗位、请说明确"这种误报。
//
// 注意：如果客户数很大（比如超过几百个），一次性把全部塞进 prompt 会让 token 成本变高、
// 也可能影响准确率，到时候需要先做一层粗筛（比如按关键词预过滤）再喂给模型。目前按
// "客户数不多"的场景实现。

const TOOL_SCHEMA = {
  name: 'report_client_update_match',
  description: '报告这条群消息对应候选列表里的哪个客户，以及更新内容摘要',
  input_schema: {
    type: 'object',
    properties: {
      matched_client_ids: {
        type: 'array',
        items: { type: 'integer' },
        description:
          '能唯一确定时，这里放 1 个客户的 id（候选列表里每个客户前面的编号）；只有在这条消息可能指向【两个及以上不同客户】、无法判断是哪个时，才放多个 id；完全无法匹配到候选列表里任何一个客户，返回空数组。注意：同一个客户名下有多个岗位不算"多个"，那仍然是 1 个客户，放 1 个 id 即可。',
      },
      update_summary: {
        type: 'string',
        description:
          '如实转述群消息里和这个客户更新有关的内容，只做必要的语言整理（比如去掉"@机器人"这种指令性文字、口语化的"呃/那个"之类填充词），不要删减信息、不要替换成不同的说法、不要自行归纳精简或补充没提到的内容。除去指令性文字外，尽量保留原文的用词和信息量。',
      },
      raw_company_guess: {
        type: 'string',
        description: '模型从原文里读出来的公司/客户名称原始文本（即使没匹配到候选列表也要填）',
      },
    },
    required: ['matched_client_ids', 'update_summary', 'raw_company_guess'],
  },
};

async function extractAndMatch(messageText, clientsList) {
  const candidateLines = clientsList
    .map(
      (c, i) =>
        `- id=${i} | 客户=${c.company}${c.positions && c.positions.length ? ` | 名下岗位=${c.positions.join('、')}` : ''}`
    )
    .join('\n');

  const systemPrompt = `你是一个帮猎头/招聘顾问团队做客户更新归档的助手。你会收到一条飞书群消息原文，以及一份当前有效的客户候选列表（每个客户还列了它名下的岗位，只作语义参考）。你的任务是判断这条消息说的是候选列表里的哪一个客户（可能因为顾问打字口语化、用简称，需要你根据语义判断，不要求逐字匹配；消息里可能提到某个具体岗位，你要据此判断它属于哪个客户）。同一个客户名下有多个岗位时，仍然只算这一个客户。然后如实转述更新内容——这是归档记录，不是摘要，不要擅自删减信息、不要替换措辞、不要过度润色，只去掉和更新本身无关的指令性文字（比如@机器人）。

两条重要的判断规则：

1）【客户名通常在开头】这个团队的习惯写法是把客户名放在第一行/标题，例如「OKX Updates」「DTCPay Updates:」「MEXC 新岗位」「Univers - Director of Product」。所以优先看消息的第一行来确定是哪个客户，正文里出现的其它公司名往往只是背景信息（比如「最理想的背景是 Palantir / Snowflake / Databricks」说的是候选人履历要求，不是客户）。

2）【当心把行话当成客户名】候选列表里可能存在名字本身就是招聘行话的客户，例如「Confidential Search」「Confidential Company」「SEA」。只有当消息确实是在讲这家客户的更新时才匹配它；如果那几个字只是在描述岗位性质（「这是一个 Confidential Search」「Confidential Role - Head of Marketing」「不能 post 广告」），那**不算**匹配到该客户——这种情况下应该去看第一行真正的客户名。宁可返回空数组让人来确认，也不要写错文档。`;

  const userPrompt = `客户候选列表：\n${candidateLines || '(候选列表为空)'}\n\n群消息原文：\n${messageText}\n\n请调用 report_client_update_match 工具报告结果。`;

  if (config.llm.provider === 'anthropic') {
    return callAnthropic(systemPrompt, userPrompt);
  }
  return callOpenAI(systemPrompt, userPrompt);
}

async function callAnthropic(systemPrompt, userPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.llm.anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: TOOL_SCHEMA.name },
    }),
  });
  const data = await resp.json();
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse) {
    throw new Error(`LLM 未返回结构化结果: ${JSON.stringify(data)}`);
  }
  return toolUse.input;
}

async function callOpenAI(systemPrompt, userPrompt) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llm.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tools: [{ type: 'function', function: { name: TOOL_SCHEMA.name, description: TOOL_SCHEMA.description, parameters: TOOL_SCHEMA.input_schema } }],
      tool_choice: { type: 'function', function: { name: TOOL_SCHEMA.name } },
    }),
  });
  const data = await resp.json();
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) {
    throw new Error(`LLM 未返回结构化结果: ${JSON.stringify(data)}`);
  }
  return JSON.parse(call.function.arguments);
}

module.exports = { extractAndMatch };

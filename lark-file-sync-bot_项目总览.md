# lark-file-sync-bot — 项目总览

生成时间：2026-07-17
写给：团队内部，用于快速了解项目现状

---

## 一句话说明

飞书（Lark Suite 国际版）群聊机器人：顾问在群里 @bot 发一句岗位更新，bot 用 LLM 识别出对应的公司/岗位，去多维表格（Base）里匹配到具体的岗位记录，把更新内容自动追加写入这条岗位关联的正式文档里，同时在群里原地回复处理结果。核心数据最终落地在两处：Base 的日志表（处理记录，用于去重和排查）和岗位对应的 Lark 文档（真正的业务归档）。

---

## 业务逻辑（端到端流程）

1. 顾问在已拉 bot 入群的飞书群里发一条消息，@bot 并说明公司、岗位和更新内容（口语化即可，不要求逐字精确）。
2. 飞书把 `im.message.receive_v1` 事件推送到开发者后台配置的回调地址 `api/lark-event.js`。这个函数要求快速返回，只做 URL 校验握手、签名/token 校验、判断事件类型三件事。
3. `api/lark-event.js` 用 `waitUntil()` 异步转发给 `api/process-message.js`（带 `x-internal-secret` 头互相校验身份，防止外部直接调用），自己立刻给飞书回 200，避免超时被重试。
4. `process-message.js` 先查日志表判断这条 `msg_id` 是否处理过（幂等去重，应对飞书重试推送），再拉取岗位信息表的全部记录。
5. 把顾问消息原文 + 全部候选岗位记录一起丢给 LLM（Claude 或 OpenAI，用 tool_use / function calling 强制结构化输出），让模型判断这条更新对应哪条候选记录，并如实转述更新内容（不做精简、不替换措辞）。
6. 根据 LLM 返回的匹配结果分四种情况处理：
   - 没匹配到任何候选 → 回复"没能匹配到"，记日志，结束。
   - 匹配到多条候选（信息不足以唯一确定）→ 列出候选让顾问重新说明确，记日志，结束。
   - 唯一匹配但这条记录没填关联文档 → 回复"匹配到了但没有关联文档"，记日志，结束。
   - 唯一匹配且有关联文档 → 进入第 7 步。
7. `docsWrite.js` 解析该记录关联的文档引用（可能是文档直链，也可能是 Wiki 节点链接，后者需要先调 Wiki API 换出真正的 document_id），在文档里找"锚点 block"（内容包含 `DOC_ANCHOR_BLOCK_TEXT`，默认 `Updates（AI总结）`），按"日期 → 岗位 → 具体更新"三层结构把新内容插入锚点下最上面（新日期/新岗位小节都插最前面，同一天同岗位的更新按序号往后接）。如果没找到锚点，退化成把内容连同一行 `⚠️` 提示插入文档最开头，避免内容丢失。
8. 无论走到哪一步，都会：在群里原地回复这条消息告知处理结果；把处理记录（msg_id / 公司 / 岗位 / 匹配到的 record_id / 状态 / 详情 / 时间）写入日志表，供去重和后续排查用。

---

## 技术架构

| 层 | 用的什么 | 说明 |
|---|---|---|
| 交互入口 | 飞书群聊消息 | 没有独立前端页面，顾问通过 @bot 发消息触发，全部交互都在飞书客户端里完成 |
| 后端 | Node.js（CommonJS）+ Vercel Serverless Functions | `api/` 目录下两个函数：`lark-event.js`（同步快速响应）、`process-message.js`（异步处理，`vercel.json` 里配了更长的 60s 超时），要求 Node >= 18 |
| 数据存储 | Lark 多维表格（Bitable）+ Lark 新版文档（docx） | 见下方"数据存在哪" |
| 身份认证 | Lark 自建应用 tenant_access_token（应用身份，非用户身份） | 两个函数之间额外用 `INTERNAL_SECRET` 头互相校验，防止外部直接调用 `process-message` |
| AI/LLM | Anthropic Claude（默认 `claude-sonnet-4-5-20250929`）或 OpenAI，二选一 | 用 tool_use / function calling 做"抽取候选记录 + 转述更新内容"，一次调用完成 |

### 数据存在哪

- **岗位信息表**（Bitable，`BASE_JOBS_TABLE_ID=tblWMTsltmMpF8rL`，挂在知识库 Wiki 节点 `JCLgwEygCiY907kU1KKlcjBxgab` 下）：存公司名、岗位名、关联文档链接等主数据，是 bot 匹配的候选池。列名靠字段名（不是列位置）读取：客户 / 项目名称 / Lark Link/Notes。
- **同步日志表**（Bitable，`BASE_LOG_TABLE_ID=tbllQecdog8LtITc`）：记录每条处理过的消息（msg_id / chat_id / raw_text / company / position / matched_record_id / status / detail / time），用于幂等去重和问题排查，不是业务数据的最终归档。
- **各岗位对应的 Lark 文档**（docx，可能通过 Wiki 节点间接引用）：真正的业务归档目的地，顾问发的每条更新最终都以"日期 → 岗位 → 更新内容"的结构追加写在这里。

### 功能速查表（以后要改某个功能，先看这里）

| 文件 | 作用 |
|---|---|
| `api/lark-event.js` | 飞书事件回调入口，URL 校验/签名校验/事件类型判断，异步转发给 process-message |
| `api/process-message.js` | 核心处理逻辑：去重 → 拉岗位表 → LLM 匹配 → 写文档 → 群内回复 → 写日志 |
| `src/config.js` | 统一读取环境变量的入口，Base 结构/字段名变了只改这里 |
| `src/larkAuth.js` | 获取并缓存 `tenant_access_token` |
| `src/larkCrypto.js` | 事件订阅"加密策略"对应的解密逻辑 |
| `src/larkBotInfo.js` | 获取 bot 自己的 `open_id`，用于核对消息确实 @ 了这个 bot |
| `src/resolveBaseAppToken.js` | 把 `BASE_APP_TOKEN` 填的 Wiki 节点链接自动换成真正的 Bitable app_token |
| `src/bitableJobs.js` | 拉取岗位表全部记录，解析关联文档引用类型（docx 直链 / Wiki 节点） |
| `src/bitableLog.js` | 日志表读写、按 msg_id 判断是否已处理过 |
| `src/llmExtract.js` | 调 LLM 做"抽取 + 匹配"，Anthropic / OpenAI 两种 provider 都支持 |
| `src/docsWrite.js` | 定位锚点 block，按日期/岗位分组把更新内容插入文档 |
| `src/messageReply.js` | 原地回复群消息 |
| `check-anchor.js` / `inspect-doc-blocks.js` / `test-*.js` | 一次性/本地排查用的调试脚本，不是生产代码路径 |

---

## 源代码在哪里

Git 远程仓库：`https://github.com/DADA-ORG/lark-file-sync-bot.git`，分支 `main`，最新提交 `71f6c2b`（"更新内容加序号；LLM改为如实转述不做精简删减"）。

⚠️ **本地有改动还没推到 GitHub**：换正式 Base、锚点找不到时改为插入文档开头、删除临时调试接口和 Netlify 遗留文件这些改动，已经在本地 commit 好了，但还没有 `git push`，只存在于本地连接的文件夹里，没有备份，也不会触发 Vercel 自动部署。需要在自己电脑上执行 `git push` 完成同步。

---

## 部署在哪里

- **平台**：Vercel（Serverless Functions，Git 集成自动部署）
- **线上地址**：推测是 `https://lark-file-sync-bot.vercel.app`（原来 `api/debug-jobs.js` 的使用说明里出现过这个地址，该文件已删除，但地址本身应该还是对的），建议登录 Vercel 后台核实项目名和归属账号。
- **部署方式**：git push 到 `main` 分支后 Vercel 自动构建部署，不需要手动跑部署命令；但环境变量在 Vercel 后台改完之后不会自动生效，需要手动触发一次 Redeploy。
- **环境变量**（只列变量名，不写值）：`LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_API_BASE_URL`、`LARK_ENCRYPT_KEY`、`LARK_VERIFICATION_TOKEN`、`BASE_APP_TOKEN`、`BASE_JOBS_TABLE_ID`、`BASE_LOG_TABLE_ID`、`BASE_FIELD_COMPANY`、`BASE_FIELD_POSITION`、`BASE_FIELD_ALIAS`、`BASE_FIELD_DOC_TOKEN`、`DOC_ANCHOR_BLOCK_TEXT`、`LLM_PROVIDER`、`LLM_MODEL`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`INTERNAL_SECRET`、`PUBLIC_URL`。

✅ **2026-07-17 已清理**：`netlify.toml`、`netlify/functions/`（Netlify 遗留部署配置）和 `api/debug-jobs.js`（用 URL 明文密钥鉴权的临时调试接口）已从代码里删除，改动已在本地 commit，push 后 Vercel 上的线上版本也会同步移除。

---

## 权限交接现状

- **Lark 自建应用**：App ID `cli_aad231d036b85ee6`，归属 dadaconsultants 账号下的自建应用；App Secret 已在 2026-07-17 换成正式凭证，写入本地 `.env` 和 Vercel 环境变量。
- **GitHub 仓库**：`DADA-ORG` 组织下的 `lark-file-sync-bot`，具体谁有 push 权限 `[待补充：不确定，建议项目负责人核实组织成员和仓库权限设置]`。
- **Vercel 项目**：归属账号未知（可能通过 GitHub OAuth 关联），建议登录 Vercel 后台在 Settings 里核实 owner 和团队成员权限。
- **Lark 正式 Base / 知识库权限**：⚠️ 截至 2026-07-17，应用访问这个正式知识库节点（`JCLgwEygCiY907kU1KKlcjBxgab`）时报错 `131006 permission denied: node permission denied, tenant needs read permission`，说明应用还没有被加为这个知识库空间/节点的协作者，正式 Base 的读写链路目前还没打通，需要知识库管理员手动把应用加进去。

---

## 相关文档索引

- `README.md` — 部署说明：Base 结构准备（岗位表/日志表/文档模板锚点）、Lark 自建应用权限配置、GitHub + Vercel 部署步骤、事件订阅回调配置、上线后的验证流程。
- `../使用指南.md` — 面向日常在群里用 bot 的顾问的使用指南：怎么 @bot、写法建议、bot 各种回复情况对照表、锚点机制详解、常见问题排查。

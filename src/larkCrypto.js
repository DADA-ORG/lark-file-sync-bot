const crypto = require('crypto');
const config = require('./config');

// 飞书事件订阅"加密策略"对应的解密逻辑。如果开发者后台没开启加密，
// LARK_ENCRYPT_KEY 留空，直接跳过解密即可。
function decryptEventBody(encryptStr) {
  const key = crypto.createHash('sha256').update(config.lark.encryptKey).digest();
  const raw = Buffer.from(encryptStr, 'base64');
  const iv = raw.subarray(0, 16);
  const cipherText = raw.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

module.exports = { decryptEventBody };

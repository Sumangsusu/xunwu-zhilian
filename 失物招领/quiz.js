// ==================== 防冒领问答：题型校验 / 答案唯一性鉴定 / 答题判定 ====================
// 纯函数模块，无 IO、无数据库依赖，可用 node scripts/check-quiz.js 直接自测。
//
// 三种题型：
//   choice   选择题：options 2~4 项，answer 为正确项下标
//   boolean  判断题：固定「是 / 否」，answer 为 0（是）或 1（否）
//   blank    填空题：answer 为标准答案，accept 为可接受的同义写法
//
// 填空题的「智能鉴定」是离线可解释规则（不调用外部 AI，答辩现场断网也能用）：
//   逐条检查答案是否唯一、明确、不含歧义连接词，任一不过则不允许发布。
//
// 试错次数：纯选择题/判断题只允许 1 次；含填空题时为 3 次（发布者可在 2~3 内调整）。
// 次数按「用户 + 启事」持久化在 quiz_attempts 表，答对即解锁，DROP 表也不会绕过。

'use strict';

const CHOICE = 'choice';
const BOOLEAN = 'boolean';
const BLANK = 'blank';
const TYPES = [CHOICE, BOOLEAN, BLANK];

// 泛化答案：这类答案几乎无法证明「只有失主知道」，一律拒绝
const GENERIC = new Set([
  '是', '否', '对', '错', '有', '无', '没有', '不确定', '不知道', '不清楚',
  '其他', '别的', '一个', '一些', '某个', 'abc', 'test', '123', '111', '000', '不知道啊'
]);

// 歧义连接词：若答案写「银行卡或现金」这类并列，判定不唯一，除非另给 accept 列表
const AMBIGUOUS = /[\/、,，;；|]|或者|或是|以及|或|和|跟|与|以及|等等|之类|大概|可能|左右/;

function text(value) {
  return String(value == null ? '' : value).trim();
}

// 归一化：忽略空白、大小写、常见标点与全半角差异
function fold(value) {
  return text(value)
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()【】\[\]《》<>"'“”‘’：:。．.,，!！?？~～—\-_·]/g, '');
}

function normalizeQuiz(raw, requestedAttempts) {
  const issues = [];
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0) return { ok: true, quiz: [], attempts: 0, issues };
  if (list.length > 5) {
    issues.push('防冒领问题最多 5 题');
    return { ok: false, quiz: [], attempts: 0, issues };
  }

  const quiz = [];
  for (let i = 0; i < list.length; i += 1) {
    const rawQ = list[i];
    if (!rawQ || typeof rawQ !== 'object') {
      issues.push(`第 ${i + 1} 题格式错误`);
      continue;
    }
    const type = TYPES.includes(rawQ.type) ? rawQ.type : CHOICE;
    const q = text(rawQ.q);
    if (!q) issues.push(`第 ${i + 1} 题缺少题干`);

    if (type === CHOICE) {
      const options = (Array.isArray(rawQ.options) ? rawQ.options : [])
        .map(text).filter(Boolean);
      const answer = Number(rawQ.answer);
      if (options.length < 2 || options.length > 4) {
        issues.push(`第 ${i + 1} 题（选择题）需填写 2~4 个选项`);
      }
      if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
        issues.push(`第 ${i + 1} 题（选择题）必须选定正确答案`);
      }
      if (q && options.length >= 2 && Number.isInteger(answer) && answer >= 0 && answer < options.length) {
        quiz.push({ type, q, options, answer });
      }
    } else if (type === BOOLEAN) {
      const answer = Number(rawQ.answer);
      if (![0, 1].includes(answer)) {
        issues.push(`第 ${i + 1} 题（判断题）必须选择「是」或「否」`);
      } else if (q) {
        quiz.push({ type, q, options: ['是', '否'], answer });
      }
    } else {
      const reviewed = reviewBlank(q, rawQ.answer, rawQ.accept);
      if (!reviewed.ok) {
        for (const message of reviewed.issues) issues.push(`第 ${i + 1} 题（填空题）：${message}`);
      } else {
        quiz.push({
          type, q, answer: reviewed.normalized,
          accept: reviewed.accept
        });
      }
    }
  }

  const hasBlank = quiz.some((q) => q.type === BLANK);
  const candidate = Number(requestedAttempts);
  let attempts = hasBlank ? 3 : 1;
  if (hasBlank && [2, 3].includes(candidate)) attempts = candidate;
  if (issues.length) return { ok: false, quiz, attempts, issues };
  return { ok: quiz.length > 0, quiz, attempts, issues };
}

// 填空题答案唯一性鉴定：返回可发布与否 + 逐条可解释的原因
function reviewBlank(question, answer, accept) {
  const issues = [];
  const normalized = text(answer);
  const folded = fold(normalized);
  const extras = (Array.isArray(accept) ? accept : []).map(text).filter(Boolean);

  if (!normalized) issues.push('答案不能为空');
  if (folded && folded.length < 2) issues.push('答案太短，至少 2 个字符（纯数字至少 3 位）');
  if (/^\d+$/.test(folded) && folded.length < 3) issues.push('纯数字答案至少 3 位，避免随手猜中');
  if (GENERIC.has(folded)) issues.push('答案过于笼统（如「是」「不知道」），无法证明失主身份');
  if (AMBIGUOUS.test(normalized) && extras.length === 0) {
    issues.push('答案含「或 / 和 / 大概」等歧义表述，请写唯一答案或补充同义写法');
  }
  if (question) {
    const qlen = fold(question).length;
    if (qlen < 6) issues.push('题干过短，请写清限定条件（如「钱包夹层里有什么」）');
    if (!/[?？]|多少|什么|哪|谁|几|颜色|型号|品牌|号码|尾号/.test(question)) {
      issues.push('题干缺少明确问法，请补充「是多少 / 叫什么 / 哪种颜色」等指向');
    }
  }
  for (const extra of extras) {
    if (!fold(extra) || GENERIC.has(fold(extra))) issues.push(`同义写法「${extra}」不明确`);
  }
  if (extras.length > 6) issues.push('同义写法最多 6 条');

  return {
    ok: issues.length === 0,
    issues,
    normalized,
    accept: extras
  };
}

// 判定一次提交是否正确。填空题忽略输入中的多余空格、大小写与标点差异。
function validateAnswer(question, submitted) {
  if (!question) return false;
  if (question.type === CHOICE || question.type === BOOLEAN) {
    return Number(submitted) === question.answer;
  }
  if (question.type === BLANK) {
    const value = fold(submitted);
    if (!value) return false;
    return value === fold(question.answer) ||
      (Array.isArray(question.accept) && question.accept.some((item) => fold(item) === value));
  }
  return false;
}

function answersCorrect(quiz, answers) {
  if (!Array.isArray(quiz) || quiz.length === 0) return true;
  if (!Array.isArray(answers) || answers.length !== quiz.length) return false;
  return quiz.every((q, i) => validateAnswer(q, answers[i]));
}

function maxAttempts(quiz) {
  const list = Array.isArray(quiz) ? quiz : [];
  if (!list.length) return 0;
  return list.some((q) => q.type === BLANK) ? 3 : 1;
}

module.exports = {
  CHOICE, BOOLEAN, BLANK, TYPES,
  normalizeQuiz, reviewBlank, validateAnswer, answersCorrect, maxAttempts, fold
};

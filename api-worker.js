const CONFIDENCE_VALUES = new Set(['guess', 'unsure', 'sure']);
const LEARNER_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const QUESTION_ID_PATTERN = /^[a-zA-Z0-9_-]{2,64}$/;

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const configured = String(env.ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (configured.includes('*')) return '*';
  return configured.includes(origin) ? origin : false;
}

function responseHeaders(origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers.Vary = 'Origin';
  }
  return headers;
}

function json(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(origin) });
}

function assertId(value, pattern, label) {
  if (!value || !pattern.test(value)) throw new ApiError(400, `${label} 格式不正确`);
  return value;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) throw new ApiError(415, '请求必须使用 application/json');
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 'JSON 内容格式不正确');
  }
}

function parseJson(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
}

async function getQuestions(db) {
  const [questionResult, optionResult] = await Promise.all([
    db.prepare(`
      SELECT id, domain, difficulty, source, question_en, question_zh,
             clauses_json, terms_json, signal_note
      FROM questions
      WHERE active = 1
      ORDER BY sort_order, id
    `).all(),
    db.prepare(`
      SELECT qo.question_id, qo.option_index, qo.option_en, qo.option_zh
      FROM question_options qo
      JOIN questions q ON q.id = qo.question_id
      WHERE q.active = 1
      ORDER BY q.sort_order, qo.option_index
    `).all()
  ]);

  const optionsByQuestion = new Map();
  optionResult.results.forEach(row => {
    if (!optionsByQuestion.has(row.question_id)) optionsByQuestion.set(row.question_id, []);
    optionsByQuestion.get(row.question_id).push({ index: row.option_index, en: row.option_en, zh: row.option_zh });
  });

  return questionResult.results.map(row => ({
    id: row.id,
    domain: row.domain,
    difficulty: row.difficulty,
    source: row.source,
    en: row.question_en,
    zh: row.question_zh,
    clauses: parseJson(row.clauses_json),
    terms: parseJson(row.terms_json),
    signal: row.signal_note,
    options: optionsByQuestion.get(row.id) || []
  }));
}

async function getTerms(db) {
  const result = await db.prepare(`
    SELECT term_key, zh, definition, example
    FROM glossary_terms
    ORDER BY term_key COLLATE NOCASE
  `).all();
  return result.results.map(row => ({ key: row.term_key, zh: row.zh, definition: row.definition, example: row.example }));
}

function mapProgress(row) {
  return {
    questionId: row.question_id,
    lastSelected: row.last_selected,
    isCorrect: row.is_correct === null ? null : Boolean(row.is_correct),
    confidence: row.confidence,
    attemptCount: row.attempt_count,
    isFavorite: Boolean(row.is_favorite),
    updatedAt: row.updated_at,
    correctOption: row.correct_option,
    explanation: row.explanation || '',
    trap: row.distractor_explanation || '',
    memory: row.memory_tip || ''
  };
}

async function getProgress(db, learnerId) {
  const result = await db.prepare(`
    SELECT qs.question_id, qs.last_selected, qs.is_correct, qs.confidence,
           qs.attempt_count, qs.is_favorite, qs.updated_at,
           CASE WHEN qs.last_selected IS NOT NULL THEN q.correct_option END AS correct_option,
           CASE WHEN qs.last_selected IS NOT NULL THEN q.explanation END AS explanation,
           CASE WHEN qs.last_selected IS NOT NULL THEN q.distractor_explanation END AS distractor_explanation,
           CASE WHEN qs.last_selected IS NOT NULL THEN q.memory_tip END AS memory_tip
    FROM question_state qs
    JOIN questions q ON q.id = qs.question_id
    WHERE qs.learner_id = ? AND q.active = 1
    ORDER BY q.sort_order, q.id
  `).bind(learnerId).all();
  return result.results.map(mapProgress);
}

async function getProgressItem(db, learnerId, questionId) {
  const row = await db.prepare(`
    SELECT qs.question_id, qs.last_selected, qs.is_correct, qs.confidence,
           qs.attempt_count, qs.is_favorite, qs.updated_at,
           CASE WHEN qs.last_selected IS NOT NULL THEN q.correct_option END AS correct_option,
           CASE WHEN qs.last_selected IS NOT NULL THEN q.explanation END AS explanation,
           CASE WHEN qs.last_selected IS NOT NULL THEN q.distractor_explanation END AS distractor_explanation,
           CASE WHEN qs.last_selected IS NOT NULL THEN q.memory_tip END AS memory_tip
    FROM question_state qs
    JOIN questions q ON q.id = qs.question_id
    WHERE qs.learner_id = ? AND qs.question_id = ? AND q.active = 1
  `).bind(learnerId, questionId).first();
  return row ? mapProgress(row) : null;
}

async function handleAttempt(request, env, origin) {
  const body = await readJson(request);
  const learnerId = assertId(body.learnerId, LEARNER_ID_PATTERN, 'learnerId');
  const questionId = assertId(body.questionId, QUESTION_ID_PATTERN, 'questionId');
  const selectedOption = Number(body.selectedOption);
  const confidence = body.confidence || 'unsure';
  if (!Number.isInteger(selectedOption) || selectedOption < 0 || selectedOption > 3) throw new ApiError(400, 'selectedOption 必须为 0 到 3');
  if (!CONFIDENCE_VALUES.has(confidence)) throw new ApiError(400, 'confidence 值不正确');

  const question = await env.DB.prepare(`
    SELECT correct_option FROM questions WHERE id = ? AND active = 1
  `).bind(questionId).first();
  if (!question) throw new ApiError(404, '题目不存在或已停用');
  const isCorrect = Number(question.correct_option) === selectedOption ? 1 : 0;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO attempts (learner_id, question_id, selected_option, is_correct, confidence)
      VALUES (?, ?, ?, ?, ?)
    `).bind(learnerId, questionId, selectedOption, isCorrect, confidence),
    env.DB.prepare(`
      INSERT INTO question_state (
        learner_id, question_id, last_selected, is_correct, confidence,
        attempt_count, is_favorite, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(learner_id, question_id) DO UPDATE SET
        last_selected = excluded.last_selected,
        is_correct = excluded.is_correct,
        confidence = excluded.confidence,
        attempt_count = question_state.attempt_count + 1,
        updated_at = CURRENT_TIMESTAMP
    `).bind(learnerId, questionId, selectedOption, isCorrect, confidence)
  ]);

  return json({ progress: await getProgressItem(env.DB, learnerId, questionId) }, 200, origin);
}

async function handleFavorite(request, env, origin, learnerId, questionId) {
  assertId(learnerId, LEARNER_ID_PATTERN, 'learnerId');
  assertId(questionId, QUESTION_ID_PATTERN, 'questionId');
  const body = await readJson(request);
  if (typeof body.favorite !== 'boolean') throw new ApiError(400, 'favorite 必须为布尔值');

  const question = await env.DB.prepare('SELECT id FROM questions WHERE id = ? AND active = 1').bind(questionId).first();
  if (!question) throw new ApiError(404, '题目不存在或已停用');

  await env.DB.prepare(`
    INSERT INTO question_state (
      learner_id, question_id, last_selected, is_correct, confidence,
      attempt_count, is_favorite, updated_at
    ) VALUES (?, ?, NULL, NULL, 'unsure', 0, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(learner_id, question_id) DO UPDATE SET
      is_favorite = excluded.is_favorite,
      updated_at = CURRENT_TIMESTAMP
  `).bind(learnerId, questionId, body.favorite ? 1 : 0).run();

  return json({ progress: await getProgressItem(env.DB, learnerId, questionId) }, 200, origin);
}

async function handleImport(request, env, origin, learnerId) {
  assertId(learnerId, LEARNER_ID_PATTERN, 'learnerId');
  const body = await readJson(request);
  if (!Array.isArray(body.progress) || body.progress.length > 500) throw new ApiError(400, 'progress 必须是不超过 500 项的数组');
  const knownQuestions = new Set((await env.DB.prepare('SELECT id FROM questions WHERE active = 1').all()).results.map(row => row.id));
  const statements = [];

  for (const item of body.progress) {
    if (!item || !knownQuestions.has(item.questionId)) continue;
    const lastSelected = item.lastSelected === null || item.lastSelected === undefined ? null : Number(item.lastSelected);
    if (lastSelected !== null && (!Number.isInteger(lastSelected) || lastSelected < 0 || lastSelected > 3)) continue;
    const confidence = CONFIDENCE_VALUES.has(item.confidence) ? item.confidence : 'unsure';
    const isCorrect = item.isCorrect === null || item.isCorrect === undefined ? null : item.isCorrect ? 1 : 0;
    const attemptCount = Math.max(0, Math.min(100000, Number.parseInt(item.attemptCount, 10) || 0));
    const isFavorite = item.isFavorite ? 1 : 0;
    statements.push(env.DB.prepare(`
      INSERT INTO question_state (
        learner_id, question_id, last_selected, is_correct, confidence,
        attempt_count, is_favorite, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(learner_id, question_id) DO UPDATE SET
        last_selected = excluded.last_selected,
        is_correct = excluded.is_correct,
        confidence = excluded.confidence,
        attempt_count = excluded.attempt_count,
        is_favorite = excluded.is_favorite,
        updated_at = CURRENT_TIMESTAMP
    `).bind(learnerId, item.questionId, lastSelected, isCorrect, confidence, attemptCount, isFavorite));
  }

  if (statements.length) await env.DB.batch(statements);
  return json({ progress: await getProgress(env.DB, learnerId) }, 200, origin);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = allowedOrigin(request, env);
  if (origin === false) return json({ error: '当前来源未被 API 允许' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(origin) });

  if (request.method === 'GET' && url.pathname === '/api/health') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM questions WHERE active = 1').first();
    return json({ ok: true, version: '2.1.0', database: 'd1', questions: row?.count || 0 }, 200, origin);
  }

  if (request.method === 'GET' && url.pathname === '/api/questions') {
    return json({ questions: await getQuestions(env.DB) }, 200, origin);
  }

  if (request.method === 'GET' && url.pathname === '/api/glossary') {
    return json({ terms: await getTerms(env.DB) }, 200, origin);
  }

  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const learnerId = assertId(url.searchParams.get('learnerId'), LEARNER_ID_PATTERN, 'learnerId');
    const [questions, terms, progress] = await Promise.all([
      getQuestions(env.DB), getTerms(env.DB), getProgress(env.DB, learnerId)
    ]);
    return json({ version: '2.1.0', learnerId, questions, terms, progress }, 200, origin);
  }

  if (request.method === 'POST' && url.pathname === '/api/attempts') {
    return handleAttempt(request, env, origin);
  }

  const favoriteMatch = url.pathname.match(/^\/api\/favorites\/([^/]+)\/([^/]+)$/);
  if (request.method === 'PUT' && favoriteMatch) {
    return handleFavorite(request, env, origin, decodeURIComponent(favoriteMatch[1]), decodeURIComponent(favoriteMatch[2]));
  }

  const importMatch = url.pathname.match(/^\/api\/progress\/([^/]+)\/import$/);
  if (request.method === 'POST' && importMatch) {
    return handleImport(request, env, origin, decodeURIComponent(importMatch[1]));
  }

  const progressMatch = url.pathname.match(/^\/api\/progress\/([^/]+)$/);
  if (progressMatch) {
    const learnerId = assertId(decodeURIComponent(progressMatch[1]), LEARNER_ID_PATTERN, 'learnerId');
    if (request.method === 'GET') return json({ progress: await getProgress(env.DB, learnerId) }, 200, origin);
    if (request.method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM attempts WHERE learner_id = ?').bind(learnerId),
        env.DB.prepare('DELETE FROM question_state WHERE learner_id = ?').bind(learnerId)
      ]);
      return json({ ok: true }, 200, origin);
    }
  }

  return json({ error: '接口不存在' }, 404, origin);
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) return json({ error: 'D1 binding DB 未配置' }, 503);
      return await handleRequest(request, env);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500) console.error('Unhandled API error', error);
      return json({ error: status === 500 ? '服务暂时不可用' : error.message }, status, allowedOrigin(request, env) || null);
    }
  }
};

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './api-worker.js';

class D1Statement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1Statement(this.database, this.sql, params);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.params) };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.params) || null;
  }

  async run() {
    return this.database.prepare(this.sql).run(...this.params);
  }
}

class MockD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
sqlite.exec(readFileSync(new URL('./seed.sql', import.meta.url), 'utf8'));

const env = {
  DB: new MockD1(sqlite),
  ALLOWED_ORIGINS: 'http://localhost:5173'
};
const learnerId = 'learner_smoke_test';

async function call(path, options = {}) {
  const response = await worker.fetch(new Request(`http://worker.test${path}`, {
    ...options,
    headers: {
      Origin: 'http://localhost:5173',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }), env);
  return { status: response.status, body: await response.json() };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const health = await call('/api/health');
check(health.status === 200 && health.body.questions === 24, 'Health check failed');

const initial = await call(`/api/bootstrap?learnerId=${learnerId}`);
check(initial.body.questions.length === 24, 'Question bootstrap failed');
check(initial.body.terms.length === 30, 'Glossary bootstrap failed');
check(initial.body.progress.length === 0, 'New learner should have no progress');
check(!('correctOption' in initial.body.questions[0]), 'Correct answer leaked before submission');
check(!('explanation' in initial.body.questions[0]), 'Explanation leaked before submission');

const attempt = await call('/api/attempts', {
  method: 'POST',
  body: JSON.stringify({ learnerId, questionId: 'q01', selectedOption: 1, confidence: 'sure' })
});
check(attempt.status === 200, 'Attempt request failed');
check(attempt.body.progress.isCorrect === true, 'Correct answer was marked wrong');
check(attempt.body.progress.correctOption === 1, 'Result omitted correct option');

const favorite = await call(`/api/favorites/${learnerId}/q02`, {
  method: 'PUT',
  body: JSON.stringify({ favorite: true })
});
check(favorite.body.progress.isFavorite === true, 'Favorite state was not saved');

sqlite.exec(readFileSync(new URL('./seed.sql', import.meta.url), 'utf8'));
const afterSeed = await call(`/api/progress/${learnerId}`);
check(afterSeed.body.progress.length === 2, 'Reseeding erased learner progress');

const insertState = sqlite.prepare(`
  INSERT INTO question_state (
    learner_id, question_id, last_selected, is_correct, confidence, attempt_count
  ) VALUES (?, 'q01', 1, 1, 'sure', 1)
`);
const insertAttempt = sqlite.prepare(`
  INSERT INTO attempts (learner_id, question_id, selected_option, is_correct, confidence)
  VALUES (?, 'q01', 1, 1, 'sure')
`);
sqlite.exec('BEGIN');
for (let index = 0; index < 600; index += 1) {
  const id = `learner_plan_${String(index).padStart(4, '0')}`;
  insertState.run(id);
  insertAttempt.run(id);
}
sqlite.exec('COMMIT');
sqlite.exec('ANALYZE');

const questionPlan = sqlite.prepare(`
  EXPLAIN QUERY PLAN SELECT * FROM questions
  WHERE active = 1 ORDER BY sort_order, id
`).all().map(row => row.detail);
const statePlan = sqlite.prepare(`
  EXPLAIN QUERY PLAN SELECT * FROM question_state WHERE learner_id = ?
`).all('learner_plan_0599').map(row => row.detail);
const attemptPlan = sqlite.prepare(`
  EXPLAIN QUERY PLAN DELETE FROM attempts WHERE learner_id = ?
`).all('learner_plan_0599').map(row => row.detail);
check(questionPlan.some(detail => detail.includes('idx_questions_active_order')), 'Question listing index is not used');
check(statePlan.some(detail => detail.includes('sqlite_autoindex_question_state_1')), 'Progress lookup index is not used');
check(attemptPlan.some(detail => detail.includes('idx_attempts_learner_answered')), 'Attempt cleanup index is not used');

const reset = await call(`/api/progress/${learnerId}`, { method: 'DELETE' });
check(reset.body.ok === true, 'Progress reset failed');
const afterReset = await call(`/api/progress/${learnerId}`);
check(afterReset.body.progress.length === 0, 'Progress remained after reset');

const blocked = await worker.fetch(new Request('http://worker.test/api/health', {
  headers: { Origin: 'https://not-allowed.example' }
}), env);
check(blocked.status === 403, 'CORS allowlist failed');

console.log(JSON.stringify({
  version: health.body.version,
  questions: initial.body.questions.length,
  terms: initial.body.terms.length,
  answersHiddenBeforeSubmit: true,
  answerReturnedAfterSubmit: true,
  favoritePersisted: true,
  reseedPreservedProgress: true,
  progressReset: true,
  corsAllowlist: true,
  indexesVerified: true
}, null, 2));

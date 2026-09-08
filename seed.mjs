import { readFile, writeFile } from 'node:fs/promises';

const questions = JSON.parse(await readFile(new URL('./questions.json', import.meta.url), 'utf8'));
const terms = JSON.parse(await readFile(new URL('./terms.json', import.meta.url), 'utf8'));

const sqlValue = value => value === null || value === undefined
  ? 'NULL'
  : typeof value === 'number'
    ? String(value)
    : `'${String(value).replaceAll("'", "''")}'`;

const statements = [
  'PRAGMA foreign_keys = ON;',
  'DELETE FROM question_options;',
  'UPDATE questions SET active = 0, updated_at = CURRENT_TIMESTAMP;',
  'DELETE FROM glossary_terms;'
];

questions.forEach((question, sortOrder) => {
  statements.push(`INSERT INTO questions (
  id, domain, difficulty, source, question_en, question_zh, correct_option,
  clauses_json, terms_json, signal_note, explanation, distractor_explanation,
  memory_tip, active, sort_order
) VALUES (${[
    question.id,
    question.domain,
    question.difficulty,
    question.source,
    question.en,
    question.zh,
    question.correct,
    JSON.stringify(question.clauses),
    JSON.stringify(question.terms),
    question.signal,
    question.why,
    question.trap,
    question.memory,
    1,
    sortOrder
  ].map(sqlValue).join(', ')})
ON CONFLICT(id) DO UPDATE SET
  domain = excluded.domain,
  difficulty = excluded.difficulty,
  source = excluded.source,
  question_en = excluded.question_en,
  question_zh = excluded.question_zh,
  correct_option = excluded.correct_option,
  clauses_json = excluded.clauses_json,
  terms_json = excluded.terms_json,
  signal_note = excluded.signal_note,
  explanation = excluded.explanation,
  distractor_explanation = excluded.distractor_explanation,
  memory_tip = excluded.memory_tip,
  active = 1,
  sort_order = excluded.sort_order,
  updated_at = CURRENT_TIMESTAMP;`);

  question.options.forEach((option, optionIndex) => {
    statements.push(`INSERT INTO question_options (question_id, option_index, option_en, option_zh) VALUES (${[
      question.id,
      optionIndex,
      option[0],
      option[1]
    ].map(sqlValue).join(', ')});`);
  });
});

Object.entries(terms).forEach(([termKey, term]) => {
  statements.push(`INSERT INTO glossary_terms (term_key, zh, definition, example) VALUES (${[
    termKey,
    term.zh,
    term.def,
    term.example
  ].map(sqlValue).join(', ')});`);
});

statements.push('PRAGMA optimize;');
await writeFile(new URL('./seed.sql', import.meta.url), `${statements.join('\n\n')}\n`);
console.log(`Generated seed.sql: ${questions.length} questions, ${Object.keys(terms).length} terms.`);

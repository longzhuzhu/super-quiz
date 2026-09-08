PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('基础', '进阶')),
  source TEXT NOT NULL DEFAULT '原创练习',
  question_en TEXT NOT NULL,
  question_zh TEXT NOT NULL,
  correct_option INTEGER NOT NULL CHECK (correct_option BETWEEN 0 AND 3),
  clauses_json TEXT NOT NULL DEFAULT '[]',
  terms_json TEXT NOT NULL DEFAULT '[]',
  signal_note TEXT NOT NULL,
  explanation TEXT NOT NULL,
  distractor_explanation TEXT NOT NULL,
  memory_tip TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS question_options (
  question_id TEXT NOT NULL,
  option_index INTEGER NOT NULL CHECK (option_index BETWEEN 0 AND 3),
  option_en TEXT NOT NULL,
  option_zh TEXT NOT NULL,
  PRIMARY KEY (question_id, option_index),
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS glossary_terms (
  term_key TEXT PRIMARY KEY,
  zh TEXT NOT NULL,
  definition TEXT NOT NULL,
  example TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  selected_option INTEGER NOT NULL CHECK (selected_option BETWEEN 0 AND 3),
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  confidence TEXT NOT NULL CHECK (confidence IN ('guess', 'unsure', 'sure')),
  answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS question_state (
  learner_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  last_selected INTEGER CHECK (last_selected BETWEEN 0 AND 3),
  is_correct INTEGER CHECK (is_correct IN (0, 1)),
  confidence TEXT NOT NULL DEFAULT 'unsure' CHECK (confidence IN ('guess', 'unsure', 'sure')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (learner_id, question_id),
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_questions_active_order
ON questions(active, sort_order, id);

CREATE INDEX IF NOT EXISTS idx_attempts_learner_answered
ON attempts(learner_id, answered_at DESC);

PRAGMA optimize;

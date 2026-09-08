'use strict';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const PREFERENCES_KEY = 'cipt-quiz-v2.1-preferences';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
})[character]);

function createLearnerId() {
  return `learner_${crypto.randomUUID()}`;
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY));
    return {
      learnerId: saved.learnerId || createLearnerId(),
      currentId: saved.currentId || null,
      confidence: saved.confidence || 'unsure',
      mode: saved.mode === 'exam' ? 'exam' : 'study',
      domain: saved.domain || '全部知识域',
      order: Array.isArray(saved.order) ? saved.order : []
    };
  } catch {
    return { learnerId: createLearnerId(), currentId: null, confidence: 'unsure', mode: 'study', domain: '全部知识域', order: [] };
  }
}

const state = {
  ...loadPreferences(),
  questions: [],
  terms: {},
  progress: new Map(),
  currentPool: [],
  selectedOption: null,
  submitted: false,
  showTranslation: true,
  ready: false
};

let toastTimer;

function savePreferences() {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
    learnerId: state.learnerId,
    currentId: state.currentId,
    confidence: state.confidence,
    mode: state.mode,
    domain: state.domain,
    order: state.order
  }));
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  const payload = await response.json().catch(() => ({ error: '服务返回了无法解析的内容' }));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function setSyncStatus(status, tone = 'pending') {
  $('#syncStatus').textContent = status;
  $('#syncDot').classList.toggle('online', tone === 'online');
  $('#syncDot').classList.toggle('offline', tone === 'offline');
}

function notify(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2400);
}

function normalizeProgress(item) {
  return {
    questionId: item.questionId,
    lastSelected: item.lastSelected ?? null,
    isCorrect: item.isCorrect ?? null,
    confidence: item.confidence || 'unsure',
    attemptCount: Number(item.attemptCount || 0),
    isFavorite: Boolean(item.isFavorite),
    correctOption: item.correctOption ?? null,
    explanation: item.explanation || '',
    trap: item.trap || '',
    memory: item.memory || '',
    updatedAt: item.updatedAt || null
  };
}

async function bootstrap() {
  setSyncStatus('正在连接');
  try {
    const payload = await api(`/api/bootstrap?learnerId=${encodeURIComponent(state.learnerId)}`);
    state.questions = payload.questions;
    state.terms = Object.fromEntries(payload.terms.map(term => [term.key, term]));
    state.progress = new Map(payload.progress.map(item => [item.questionId, normalizeProgress(item)]));
    state.ready = true;
    state.showTranslation = state.mode === 'study';
    hydrateControls();
    renderQuestion();
    renderGlossary();
    updateStats();
    setSyncStatus('已同步', 'online');
  } catch (error) {
    state.ready = false;
    setSyncStatus('连接失败', 'offline');
    showLoadError(error.message);
  }
}

function showLoadError(message) {
  $('.question-body').innerHTML = `
    <div class="empty-state">
      <div class="empty-symbol">!</div>
      <h3>暂时无法读取题库</h3>
      <p>${escapeHtml(message)}。请确认 Worker API 已启动，并检查 VITE_API_BASE_URL。</p>
      <button class="primary-button" id="retryButton" type="button">重新连接</button>
    </div>`;
  $('#retryButton').addEventListener('click', () => location.reload());
}

function hydrateControls() {
  const domains = ['全部知识域', ...new Set(state.questions.map(question => question.domain))];
  if (!domains.includes(state.domain)) state.domain = '全部知识域';
  $('#domainSelect').innerHTML = domains.map(domain => `<option value="${escapeHtml(domain)}">${escapeHtml(domain)}</option>`).join('');
  $('#domainSelect').value = state.domain;
  $$('.mode-button').forEach(button => button.classList.toggle('active', button.dataset.mode === state.mode));
}

function buildPool() {
  const validIds = new Set(state.questions.map(question => question.id));
  const ordered = state.order
    .filter(id => validIds.has(id))
    .map(id => state.questions.find(question => question.id === id));
  state.questions.forEach(question => {
    if (!ordered.some(item => item.id === question.id)) ordered.push(question);
  });
  state.order = ordered.map(question => question.id);
  state.currentPool = state.domain === '全部知识域'
    ? ordered
    : ordered.filter(question => question.domain === state.domain);
  if (!state.currentPool.some(question => question.id === state.currentId)) {
    state.currentId = state.currentPool[0]?.id || null;
  }
}

function currentQuestion() {
  return state.currentPool.find(question => question.id === state.currentId) || state.currentPool[0];
}

function renderQuestion() {
  if (!state.ready) return;
  buildPool();
  const question = currentQuestion();
  if (!question) return showLoadError('题库为空');
  const saved = state.progress.get(question.id);
  state.selectedOption = saved?.lastSelected ?? null;
  state.submitted = saved?.lastSelected !== null && saved?.lastSelected !== undefined;
  state.currentId = question.id;

  $('#domainTag').textContent = question.domain;
  $('#difficultyTag').textContent = question.difficulty;
  $('#sourceTag').textContent = question.source;
  $('#questionNumber').textContent = String(state.currentPool.indexOf(question) + 1).padStart(2, '0');
  $('#questionText').textContent = question.en;
  $('#questionTranslation').textContent = question.zh;
  $('#questionTermCount').textContent = question.terms.length;
  $('#signalNote').textContent = question.signal;

  const favorite = Boolean(saved?.isFavorite);
  $('#favoriteButton').classList.toggle('active', favorite);
  $('#favoriteButton').textContent = favorite ? '★' : '☆';
  $('#favoriteButton').setAttribute('aria-pressed', String(favorite));
  $('#favoriteButton').setAttribute('aria-label', favorite ? '取消收藏本题' : '收藏本题');

  $('#clauseList').innerHTML = question.clauses.map((part, index) => `
    <div class="clause">
      <span class="clause-number">${String(index + 1).padStart(2, '0')}</span>
      <div><div class="clause-en">${escapeHtml(part[0])}</div><div class="clause-zh">${escapeHtml(part[1])}</div></div>
    </div>`).join('');

  $('#questionTerms').innerHTML = question.terms.map(key => {
    const term = state.terms[key];
    return term
      ? `<div class="mini-term"><strong>${escapeHtml(key)}</strong><span>${escapeHtml(term.zh)} · ${escapeHtml(term.definition)}</span></div>`
      : '';
  }).join('');

  $('#options').innerHTML = question.options.map((option, index) => {
    const selected = state.selectedOption === index;
    const correct = state.submitted && index === saved.correctOption;
    const wrong = state.submitted && selected && index !== saved.correctOption;
    const classes = ['option', selected ? 'selected' : '', correct ? 'correct' : '', wrong ? 'wrong' : ''].filter(Boolean).join(' ');
    return `<button class="${classes}" type="button" role="radio" aria-checked="${selected}" data-option="${index}" ${state.submitted ? 'disabled' : ''}>
      <span class="option-letter">${String.fromCharCode(65 + index)}</span>
      <span><span class="option-en">${escapeHtml(option.en)}</span><span class="option-zh">${escapeHtml(option.zh)}</span></span>
      <span class="option-mark">${correct ? '✓' : wrong ? '×' : ''}</span>
    </button>`;
  }).join('');

  $$('.option').forEach(button => button.addEventListener('click', () => chooseOption(Number(button.dataset.option))));
  $('#submitButton').disabled = state.selectedOption === null || state.submitted;
  $('#submitButton').textContent = state.submitted ? '已提交' : '提交答案';
  $('#explanation').classList.toggle('show', state.submitted);
  if (state.submitted) renderExplanation(saved);

  setTranslation(state.showTranslation);
  $('#breakdownPanel').classList.remove('show');
  $('#questionTermsPanel').classList.remove('show');
  $('#breakdownToggle').classList.remove('active');
  $('#termsToggle').classList.remove('active');
  $('#breakdownToggle').setAttribute('aria-expanded', 'false');
  $('#termsToggle').setAttribute('aria-expanded', 'false');
  $$('.confidence-button').forEach(button => {
    button.classList.toggle('active', button.dataset.confidence === (saved?.confidence || state.confidence));
  });

  const index = state.currentPool.indexOf(question);
  const answeredInPool = state.currentPool.filter(item => state.progress.get(item.id)?.lastSelected !== null && state.progress.get(item.id)?.lastSelected !== undefined).length;
  $('#progressText').textContent = `第 ${index + 1} / ${state.currentPool.length} 题`;
  $('#progressFill').style.width = `${((index + 1) / state.currentPool.length) * 100}%`;
  $('#answeredText').textContent = `已答 ${answeredInPool}`;
  $('#previousButton').disabled = state.currentPool.length <= 1;
  $('#nextButton').textContent = index === state.currentPool.length - 1 ? '回到第 1 题' : '下一题';
  savePreferences();
}

function chooseOption(index) {
  if (state.submitted) return;
  state.selectedOption = index;
  $$('.option').forEach((button, optionIndex) => {
    button.classList.toggle('selected', optionIndex === index);
    button.setAttribute('aria-checked', String(optionIndex === index));
  });
  $('#submitButton').disabled = false;
}

async function submitAnswer() {
  if (state.selectedOption === null || state.submitted) return;
  const question = currentQuestion();
  const confidence = $('.confidence-button.active')?.dataset.confidence || 'unsure';
  $('#submitButton').disabled = true;
  $('#submitButton').textContent = '正在提交…';
  setSyncStatus('正在同步');
  try {
    const result = await api('/api/attempts', {
      method: 'POST',
      body: JSON.stringify({
        learnerId: state.learnerId,
        questionId: question.id,
        selectedOption: state.selectedOption,
        confidence
      })
    });
    state.progress.set(question.id, normalizeProgress(result.progress));
    state.submitted = true;
    setSyncStatus('已同步', 'online');
    renderQuestion();
    updateStats();
    setTimeout(() => $('#explanation').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40);
  } catch (error) {
    $('#submitButton').disabled = false;
    $('#submitButton').textContent = '重新提交';
    setSyncStatus('同步失败', 'offline');
    notify(error.message);
  }
}

function renderExplanation(saved) {
  const correct = Boolean(saved.isCorrect);
  const answerLetter = String.fromCharCode(65 + saved.correctOption);
  $('#resultBanner').className = `result-banner ${correct ? 'correct' : 'wrong'}`;
  $('#resultBanner').textContent = correct ? `✓ 回答正确 · 答案 ${answerLetter}` : `× 回答错误 · 正确答案 ${answerLetter}`;
  $('#explainWhy').textContent = saved.explanation;
  $('#explainTrap').textContent = saved.trap;
  $('#memoryLine').textContent = saved.memory;
}

function setTranslation(visible) {
  state.showTranslation = visible;
  $('#questionTranslation').hidden = !visible;
  $$('.option-zh').forEach(element => { element.hidden = !visible; });
  $('#translationToggle').classList.toggle('active', visible);
  $('#translationToggle').textContent = `中译 ${visible ? 'ON' : 'OFF'}`;
  $('#translationToggle').setAttribute('aria-pressed', String(visible));
}

function moveQuestion(step) {
  const index = state.currentPool.indexOf(currentQuestion());
  const nextIndex = (index + step + state.currentPool.length) % state.currentPool.length;
  state.currentId = state.currentPool[nextIndex].id;
  renderQuestion();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function toggleFavorite() {
  const question = currentQuestion();
  const previous = state.progress.get(question.id) || normalizeProgress({ questionId: question.id });
  const favorite = !previous.isFavorite;
  $('#favoriteButton').disabled = true;
  try {
    const result = await api(`/api/favorites/${encodeURIComponent(state.learnerId)}/${encodeURIComponent(question.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ favorite })
    });
    state.progress.set(question.id, normalizeProgress({ ...previous, ...result.progress }));
    renderQuestion();
    updateStats();
    notify(favorite ? '已加入收藏' : '已取消收藏');
  } catch (error) {
    notify(error.message);
  } finally {
    $('#favoriteButton').disabled = false;
  }
}

function reviewItems() {
  return state.questions.filter(question => {
    const progress = state.progress.get(question.id);
    return progress && (progress.isFavorite || progress.isCorrect === false || progress.confidence === 'guess');
  });
}

function updateStats() {
  const progress = [...state.progress.values()];
  const answered = progress.filter(item => item.lastSelected !== null);
  const correct = answered.filter(item => item.isCorrect).length;
  const accuracy = answered.length ? Math.round(correct / answered.length * 100) : 0;
  const weak = reviewItems().length;
  const favorites = progress.filter(item => item.isFavorite).length;
  const totalAttempts = progress.reduce((sum, item) => sum + item.attemptCount, 0);

  $('#accuracyRing').style.setProperty('--score', accuracy);
  $('#accuracyValue').textContent = answered.length ? `${accuracy}%` : '--';
  $('#accuracyCopy').textContent = answered.length ? (accuracy >= 80 ? '状态不错' : accuracy >= 60 ? '继续巩固' : '先理解考点') : '开始答题';
  $('#accuracyHint').textContent = answered.length ? `已覆盖 ${answered.length} 道题` : '正确率将在这里更新';
  $('#correctMetric').textContent = correct;
  $('#weakMetric').textContent = weak;
  $('#wrongCount').textContent = weak;
  $('#termCount').textContent = Object.keys(state.terms).length;
  $('#totalAnsweredMetric').textContent = totalAttempts;
  $('#favoriteMetric').textContent = favorites;
  $('#dataSummary').textContent = answered.length
    ? `已覆盖 ${answered.length} 道题，累计作答 ${totalAttempts} 次，当前正确率 ${accuracy}%。`
    : '尚无答题记录。';
}

function renderReview() {
  const items = reviewItems();
  $('#startReviewButton').disabled = !items.length;
  if (!items.length) {
    $('#reviewGrid').innerHTML = `<div class="panel empty-state"><div class="empty-symbol">✓</div><h3>暂时没有待复习题目</h3><p>答错、低把握或已收藏的题目会出现在这里。</p><button class="secondary-button" type="button" data-go-study>去练习</button></div>`;
    $('[data-go-study]').addEventListener('click', () => switchView('study'));
    return;
  }
  $('#reviewGrid').innerHTML = items.map(question => {
    const progress = state.progress.get(question.id);
    const reasons = [progress.isCorrect === false || progress.confidence === 'guess' ? '需复习' : '', progress.isFavorite ? '已收藏' : ''].filter(Boolean).join(' · ');
    return `<article class="panel review-card"><span class="tag cyan">${escapeHtml(question.domain)}</span><h3>${escapeHtml(question.en)}</h3><p>${escapeHtml(question.zh)}</p><footer><span class="tag amber">${escapeHtml(reasons)}</span><button class="secondary-button" type="button" data-review-id="${question.id}">练这道</button></footer></article>`;
  }).join('');
  $$('[data-review-id]').forEach(button => button.addEventListener('click', () => openQuestion(button.dataset.reviewId)));
}

function renderGlossary(query = '') {
  const normalized = query.trim().toLowerCase();
  const entries = Object.entries(state.terms).filter(([key, term]) => !normalized || `${key} ${term.zh} ${term.definition}`.toLowerCase().includes(normalized));
  $('#glossaryGrid').innerHTML = entries.length
    ? entries.map(([key, term]) => `<article class="panel term-card"><span class="term-cn">${escapeHtml(term.zh)}</span><h3>${escapeHtml(key)}</h3><p>${escapeHtml(term.definition)}</p><p class="term-example">例：${escapeHtml(term.example)}</p></article>`).join('')
    : `<div class="panel empty-state"><div class="empty-symbol">Aa</div><h3>没有匹配的术语</h3><p>试试搜索“加密”“privacy”或“数据”。</p></div>`;
}

function openQuestion(id) {
  state.domain = '全部知识域';
  $('#domainSelect').value = state.domain;
  state.currentId = id;
  switchView('study');
  renderQuestion();
}

function switchView(name) {
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $$('.nav-button').forEach(button => button.setAttribute('aria-selected', String(button.dataset.view === name)));
  const meta = {
    study: ['今日练习', '读懂题干，再做判断'],
    review: ['错题复习', '集中处理薄弱项'],
    glossary: ['术语词库', '中英概念快速检索'],
    data: ['学习数据', 'D1 云端进度与备份']
  }[name];
  $('#pageTitle').textContent = meta[0];
  $('#pageSubtitle').textContent = meta[1];
  if (name === 'review') renderReview();
  if (name === 'glossary') renderGlossary($('#termSearch').value);
  if (name === 'data') updateStats();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function shuffleQuestions() {
  const order = state.questions.map(question => question.id);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [order[index], order[randomIndex]] = [order[randomIndex], order[index]];
  }
  state.order = order;
  buildPool();
  state.currentId = state.currentPool[0].id;
  renderQuestion();
  notify('题目顺序已随机调整');
}

function exportProgress() {
  const data = {
    app: 'CIPT Quiz System V2.1',
    exportedAt: new Date().toISOString(),
    learnerId: state.learnerId,
    progress: [...state.progress.values()]
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `cipt-quiz-v2.1-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  notify('学习数据已导出');
}

async function importProgress(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.progress)) throw new Error('备份文件缺少 progress 数组');
    const result = await api(`/api/progress/${encodeURIComponent(state.learnerId)}/import`, {
      method: 'POST',
      body: JSON.stringify({ progress: parsed.progress })
    });
    state.progress = new Map(result.progress.map(item => [item.questionId, normalizeProgress(item)]));
    renderQuestion();
    renderReview();
    updateStats();
    notify('学习数据已恢复到 D1');
  } catch (error) {
    notify(`导入失败：${error.message}`);
  } finally {
    $('#importFile').value = '';
  }
}

async function resetProgress() {
  if (!confirm('确定清空该匿名学习 ID 的全部答题记录、错题和收藏吗？此操作无法撤销。')) return;
  try {
    await api(`/api/progress/${encodeURIComponent(state.learnerId)}`, { method: 'DELETE' });
    state.progress.clear();
    renderQuestion();
    renderReview();
    updateStats();
    notify('云端学习记录已清空');
  } catch (error) {
    notify(error.message);
  }
}

function bindEvents() {
  $$('.nav-button').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#translationToggle').addEventListener('click', () => setTranslation(!state.showTranslation));
  $('#breakdownToggle').addEventListener('click', () => {
    const open = !$('#breakdownPanel').classList.contains('show');
    $('#breakdownPanel').classList.toggle('show', open);
    $('#breakdownToggle').classList.toggle('active', open);
    $('#breakdownToggle').setAttribute('aria-expanded', String(open));
  });
  $('#termsToggle').addEventListener('click', () => {
    const open = !$('#questionTermsPanel').classList.contains('show');
    $('#questionTermsPanel').classList.toggle('show', open);
    $('#termsToggle').classList.toggle('active', open);
    $('#termsToggle').setAttribute('aria-expanded', String(open));
  });
  $('#favoriteButton').addEventListener('click', toggleFavorite);
  $('#submitButton').addEventListener('click', submitAnswer);
  $('#previousButton').addEventListener('click', () => moveQuestion(-1));
  $('#nextButton').addEventListener('click', () => moveQuestion(1));
  $$('.confidence-button').forEach(button => button.addEventListener('click', () => {
    if (state.submitted) return;
    state.confidence = button.dataset.confidence;
    $$('.confidence-button').forEach(item => item.classList.toggle('active', item === button));
    savePreferences();
  }));
  $('#domainSelect').addEventListener('change', event => {
    state.domain = event.target.value;
    buildPool();
    state.currentId = state.currentPool[0]?.id || null;
    renderQuestion();
  });
  $$('.mode-button').forEach(button => button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    $$('.mode-button').forEach(item => item.classList.toggle('active', item === button));
    setTranslation(state.mode === 'study');
    savePreferences();
    notify(state.mode === 'study' ? '学习模式：默认显示中译' : '自测模式：默认隐藏中译');
  }));
  $('#shuffleButton').addEventListener('click', shuffleQuestions);
  $('#startReviewButton').addEventListener('click', () => {
    const ids = reviewItems().map(question => question.id);
    if (!ids.length) return;
    state.order = [...ids, ...state.questions.map(question => question.id).filter(id => !ids.includes(id))];
    state.domain = '全部知识域';
    $('#domainSelect').value = state.domain;
    state.currentId = ids[0];
    switchView('study');
    renderQuestion();
  });
  $('#termSearch').addEventListener('input', event => renderGlossary(event.target.value));
  $('#exportButton').addEventListener('click', exportProgress);
  $('#importButton').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', event => importProgress(event.target.files[0]));
  $('#resetButton').addEventListener('click', resetProgress);
  document.addEventListener('keydown', event => {
    if (!state.ready || !$('#view-study').classList.contains('active') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (/^[1-4]$/.test(event.key)) chooseOption(Number(event.key) - 1);
    if (event.key.toLowerCase() === 't') setTranslation(!state.showTranslation);
    if (event.key.toLowerCase() === 'f') toggleFavorite();
    if (event.key === 'Enter') {
      event.preventDefault();
      state.submitted ? moveQuestion(1) : submitAnswer();
    }
  });
}

bindEvents();
bootstrap();

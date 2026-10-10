(() => {
  'use strict';

  const LETTERS = ['A', 'B', 'C', 'D'];
  const STORAGE_KEY = 'quizmaster-state-v1';
  const MIN_TEAMS = 2;
  const MAX_TEAMS = 20;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M4.5 12.5l5 5L19.5 7"/></svg>';
  const ICON_CROSS = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  // ---------- Question bank ----------
  const BANK = normalizeBank(typeof QUESTION_BANK !== 'undefined' ? QUESTION_BANK : []);

  function normalizeBank(raw) {
    return raw.map((q, i) => {
      if (!q || !q.question || !Array.isArray(q.options) || q.options.length !== 4) {
        console.warn(`Skipping question #${i + 1}: needs a question and exactly 4 options.`, q);
        return null;
      }
      let ans = q.answer;
      if (typeof ans === 'string') ans = LETTERS.indexOf(ans.trim().toUpperCase());
      if (!(ans >= 0 && ans <= 3)) {
        console.warn(`Skipping question #${i + 1}: answer must be A, B, C or D.`, q);
        return null;
      }
      return {
        question: String(q.question),
        options: q.options.map(String),
        answer: ans,
        explanation: q.explanation ? String(q.explanation) : '',
      };
    }).filter(Boolean);
  }

  // ---------- State & persistence ----------
  // phase: 'question' -> 'reveal' -> 'leaderboard' -> (next question | 'final')
  let state = null;
  let busy = false; // true while an animated transition is running

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }
  function loadSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return s && Array.isArray(s.teams) && Array.isArray(s.questions) ? s : null;
    } catch (e) { return null; }
  }
  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* storage unavailable */ }
  }

  const currentQ = () => state.questions[state.qIndex];

  // Standard competition ranking: equal scores share a rank (1, 1, 3 ...)
  function rankRows(scores) {
    const rows = scores.map((score, idx) => ({ score, idx }));
    rows.sort((a, b) => b.score - a.score || a.idx - b.idx);
    rows.forEach((r, i) => {
      r.rank = i > 0 && r.score === rows[i - 1].score ? rows[i - 1].rank : i + 1;
    });
    return rows;
  }
  function standings() {
    return rankRows(state.teams.map((t) => t.score)).map((r) => ({ ...state.teams[r.idx], ...r }));
  }
  function rankMap() {
    const m = {};
    standings().forEach((r) => { m[r.idx] = r.rank; });
    return m;
  }

  function show(id) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    const inQuiz = id === 'screen-question' || id === 'screen-board';
    $('#btn-end').classList.toggle('hidden', !inQuiz);
    document.body.classList.toggle('wide', id === 'screen-question');
    $('#brand-title').textContent = state ? state.title : 'Quiz Master';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- Splash intro ----------
  function splash(kicker, title, duration = 1300) {
    if (reducedMotion()) return Promise.resolve();
    const el = $('#splash');
    $('#splash-kicker').textContent = kicker;
    $('#splash-title').textContent = title;
    el.classList.remove('hidden', 'out');
    // Restart child animations
    el.querySelectorAll('*').forEach((n) => { n.style.animation = 'none'; void n.offsetWidth; n.style.animation = ''; });
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('click', finish);
        el.classList.add('out');
        resolve();
        setTimeout(() => el.classList.add('hidden'), 500);
      };
      el.addEventListener('click', finish);
      setTimeout(finish, duration);
    });
  }

  // ---------- Modal ----------
  let modalAction = null;
  function confirmModal(title, text, okLabel, onOk, danger = false) {
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    const ok = $('#modal-ok');
    ok.textContent = okLabel;
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    modalAction = onOk;
    $('#modal').classList.remove('hidden');
    ok.focus();
  }
  function closeModal() { $('#modal').classList.add('hidden'); modalAction = null; }

  // =========================================================
  // SETUP
  // =========================================================
  function renderTeamInputs() {
    const countInput = $('#team-count');
    const n = clamp(parseInt(countInput.value, 10) || MIN_TEAMS, MIN_TEAMS, MAX_TEAMS);
    countInput.value = n;
    const wrap = $('#team-inputs');
    const existing = $$('#team-inputs input').map((i) => i.value);
    wrap.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'team-input' + (i >= existing.length ? ' new' : '');
      d.style.animationDelay = `${(i - existing.length) * 50}ms`;
      d.innerHTML = `<span class="team-num">${i + 1}</span>
        <input type="text" maxlength="30" placeholder="Team ${i + 1}" value="${esc(existing[i] ?? '')}" aria-label="Name of team ${i + 1}">`;
      wrap.appendChild(d);
    }
  }

  function initSetup() {
    const qc = $('#question-count');
    qc.max = BANK.length;
    qc.value = BANK.length;
    $('#bank-info').textContent = BANK.length
      ? `${BANK.length} question${BANK.length === 1 ? '' : 's'} available in questions.js`
      : 'No valid questions found — add some to questions.js';
    renderTeamInputs();

    const saved = loadSaved();
    if (saved && saved.phase !== 'final') {
      const where = saved.phase === 'leaderboard' ? 'leaderboard after' : 'on';
      $('#resume-text').textContent =
        `"${saved.title}" with ${saved.teams.length} teams — ${where} question ${saved.qIndex + 1} of ${saved.questions.length}.`;
      $('#resume-banner').classList.remove('hidden');
    }
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startQuiz() {
    const err = $('#setup-error');
    err.textContent = '';
    if (!BANK.length) { err.textContent = 'No valid questions found. Add questions to questions.js first.'; return; }

    const names = $$('#team-inputs input').map((inp, i) => inp.value.trim() || `Team ${i + 1}`);
    const seen = new Set();
    for (const n of names) {
      const k = n.toLowerCase();
      if (seen.has(k)) { err.textContent = `Team names must be unique — "${n}" appears more than once.`; return; }
      seen.add(k);
    }
    const points = parseInt($('#points').value, 10);
    if (!(points > 0)) { err.textContent = 'Points per correct answer must be at least 1.'; return; }
    const qCount = parseInt($('#question-count').value, 10);
    if (!(qCount >= 1 && qCount <= BANK.length)) {
      err.textContent = `Questions to play must be between 1 and ${BANK.length}.`; return;
    }

    let qs = $('#shuffle').checked ? shuffled(BANK) : BANK.slice();
    qs = qs.slice(0, qCount);
    if ($('#shuffle-options').checked) {
      // Reorder A-D and remap the correct answer to its new position
      qs = qs.map((q) => {
        const order = shuffled([0, 1, 2, 3]);
        return { ...q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
      });
    }

    state = {
      title: $('#quiz-title').value.trim() || 'Quiz Master',
      points,
      teams: names.map((name) => ({ name, score: 0, correct: 0 })),
      questions: qs,
      qIndex: 0,
      phase: 'question',
      responses: {},
      prev: null,
      played: 0,
    };
    $('#resume-banner').classList.add('hidden');
    save();
    introQuestion();
  }

  // =========================================================
  // QUESTION / REVEAL
  // =========================================================
  async function introQuestion() {
    busy = true;
    const p = splash(state.title,
      state.qIndex === state.questions.length - 1 ? 'Final Question' : `Question ${state.qIndex + 1}`);
    await p;
    renderQuestion();
    busy = false;
  }

  function renderQuestion() {
    const q = currentQ();
    const total = state.questions.length;

    $('#q-counter').textContent = `QUESTION ${state.qIndex + 1} OF ${total}`;
    $('#q-points').textContent = `${state.points} points per correct answer`;
    $('#q-badge').textContent = `Q${state.qIndex + 1}`;
    // Text after a blank line (e.g. a code snippet) is shown as a code block
    const [prompt, ...rest] = q.question.split(/\n\s*\n/);
    const code = rest.join('\n\n');
    $('#q-text').textContent = prompt;
    const codeEl = $('#q-code');
    codeEl.textContent = code;
    codeEl.classList.toggle('hidden', !code);

    $('#options').innerHTML = q.options.map((opt, i) => `
      <div class="option" data-idx="${i}">
        <span class="letter">${LETTERS[i]}</span>
        <div class="opt-body">
          <div class="opt-text">${esc(opt)}</div>
          <div class="picks"></div>
        </div>
        <span class="mark"></span>
      </div>`).join('');

    $('#team-responses').innerHTML = state.teams.map((t, ti) => `
      <div class="team-card" data-team="${ti}" style="--i:${ti}">
        <div class="team-head"><span class="team-name">${esc(t.name)}</span></div>
        <div class="choice-row">
          ${LETTERS.map((L, oi) => `<button type="button" class="choice" data-team="${ti}" data-opt="${oi}" aria-label="${esc(t.name)} answers ${L}">${L}</button>`).join('')}
        </div>
      </div>`).join('');

    const card = $('#question-card');
    card.classList.remove('enter', 'scanning');
    void card.offsetWidth; // restart entrance animation
    card.classList.add('enter');

    show('screen-question');
    updateQuestionUI(false);
  }

  function updateQuestionUI(justRevealed) {
    const q = currentQ();
    const revealed = state.phase === 'reveal';
    const total = state.questions.length;
    const answered = Object.keys(state.responses).length;

    $('#progress-bar').style.width = `${((state.qIndex + (revealed ? 1 : 0)) / total) * 100}%`;

    // Reveal styles must not compete with the entrance animation
    if (revealed) $('#question-card').classList.remove('enter', 'scanning');

    $$('.choice').forEach((b) => {
      const t = +b.dataset.team, o = +b.dataset.opt;
      b.classList.toggle('selected', state.responses[t] === o);
      b.disabled = revealed;
    });

    const pill = $('#answered-count');
    pill.textContent = `${answered} / ${state.teams.length} answered`;
    pill.classList.toggle('complete', answered === state.teams.length);

    $$('.team-card').forEach((card) => {
      const t = +card.dataset.team;
      const resp = state.responses[t];
      card.classList.toggle('answered', resp !== undefined);
      card.classList.remove('right', 'wrong', 'none', 'revealed');
      card.querySelectorAll('.result-badge, .float-points').forEach((n) => n.remove());
      if (!revealed) return;

      if (justRevealed) card.classList.add('revealed');
      const badge = document.createElement('span');
      badge.className = 'result-badge';
      if (resp === undefined) {
        card.classList.add('none'); badge.textContent = 'No answer';
      } else if (resp === q.answer) {
        card.classList.add('right'); badge.textContent = `✓ +${state.points}`;
        if (justRevealed) {
          const f = document.createElement('span');
          f.className = 'float-points'; f.textContent = `+${state.points}`;
          card.appendChild(f);
        }
      } else {
        card.classList.add('wrong'); badge.textContent = '✗ 0';
      }
      card.querySelector('.team-head').appendChild(badge);
    });

    $$('.option').forEach((optEl) => {
      const i = +optEl.dataset.idx;
      optEl.classList.remove('correct', 'wrong', 'dim', 'scan');
      const picks = optEl.querySelector('.picks');
      const mark = optEl.querySelector('.mark');
      picks.innerHTML = ''; mark.innerHTML = '';
      if (!revealed) return;

      const pickers = state.teams.filter((_, ti) => state.responses[ti] === i);
      picks.innerHTML = pickers.map((t, k) =>
        `<span class="pick-chip" style="animation-delay:${0.4 + k * 0.07}s">${esc(t.name)}</span>`).join('');
      if (i === q.answer) { optEl.classList.add('correct'); mark.innerHTML = ICON_CHECK; }
      else if (pickers.length) { optEl.classList.add('wrong'); mark.innerHTML = ICON_CROSS; }
      else optEl.classList.add('dim');
    });

    const banner = $('#answer-banner');
    if (revealed) {
      const right = state.teams.filter((_, ti) => state.responses[ti] === q.answer).length;
      banner.innerHTML = `Correct answer: <strong>${LETTERS[q.answer]} — ${esc(q.options[q.answer])}</strong>
        ${q.explanation ? `<span class="explain">${esc(q.explanation)}</span>` : ''}
        <span class="stat">${right} of ${state.teams.length} team${state.teams.length === 1 ? '' : 's'} answered correctly</span>`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    $('#btn-submit').classList.toggle('hidden', revealed);
    $('#btn-submit').disabled = false;
    $('#btn-undo').classList.toggle('hidden', !revealed);
    $('#btn-to-board').classList.toggle('hidden', !revealed);
  }

  function onChoiceClick(e) {
    const b = e.target.closest('.choice');
    if (!b || !state || state.phase !== 'question' || busy) return;
    const t = +b.dataset.team, o = +b.dataset.opt;
    if (state.responses[t] === o) delete state.responses[t]; // click again to clear
    else state.responses[t] = o;
    save();
    updateQuestionUI(false);
  }

  function submitAnswers() {
    if (busy || state.phase !== 'question') return;
    const missing = state.teams.filter((_, i) => state.responses[i] === undefined).map((t) => t.name);
    if (missing.length) {
      confirmModal(
        'Some teams have no answer',
        `No response recorded for: ${missing.join(', ')}. They will score 0 for this question.`,
        'Submit Anyway',
        reveal,
      );
    } else {
      reveal();
    }
  }

  async function reveal() {
    if (state.phase !== 'question' || busy) return;
    busy = true;
    const q = currentQ();

    // Score first so a refresh mid-animation can't lose or double-count points
    state.prev = {
      scores: state.teams.map((t) => t.score),
      correct: state.teams.map((t) => t.correct),
      ranks: rankMap(),
    };
    state.teams.forEach((t, i) => {
      if (state.responses[i] === q.answer) { t.score += state.points; t.correct += 1; }
    });
    state.phase = 'reveal';
    state.played = state.qIndex + 1;
    save();

    $('#btn-submit').disabled = true;
    $$('.choice').forEach((b) => { b.disabled = true; });
    if (window.innerWidth < 1100) $('#question-card').scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Suspense: a highlight sweeps across the options and slows down onto the answer
    if (!reducedMotion()) {
      const card = $('#question-card');
      const opts = $$('.option');
      card.classList.remove('enter');
      card.classList.add('scanning');
      const steps = 8 + q.answer;
      for (let s = 0; s <= steps; s++) {
        opts.forEach((o, i) => o.classList.toggle('scan', i === s % 4));
        await wait(70 + Math.pow(s / steps, 3) * 260);
      }
      await wait(250);
    }

    updateQuestionUI(true);
    busy = false;
    if (state.teams.some((_, i) => state.responses[i] === q.answer)) setTimeout(() => burstConfetti(70), 300);
  }

  // Lets the quizmaster fix a mis-entered response before moving on
  function undoReveal() {
    if (busy || state.phase !== 'reveal' || !state.prev) return;
    state.teams.forEach((t, i) => {
      t.score = state.prev.scores[i];
      t.correct = state.prev.correct[i];
    });
    state.phase = 'question';
    state.played = state.qIndex;
    save();
    updateQuestionUI(false);
  }

  // =========================================================
  // LEADERBOARD
  // =========================================================
  function renderBoard() {
    if (busy) return;
    state.phase = 'leaderboard';
    save();

    const total = state.questions.length;
    const isLast = state.qIndex >= total - 1;
    const rows = standings();
    const prev = state.prev;
    const max = Math.max(1, ...rows.map((r) => r.score));

    // Where each team stood before this question (for the re-ordering animation)
    const prevOrder = prev ? rankRows(prev.scores) : rows;
    const prevPos = {};
    prevOrder.forEach((r, i) => { prevPos[r.idx] = i; });
    // Rank arrows only mean something once teams have been separated
    const showMoves = prev && new Set(prev.scores).size > 1;

    $('#board-eyebrow').textContent = `Standings after Question ${state.qIndex + 1} of ${total}`;
    $('#board-list').classList.toggle('compact', rows.length > 5);

    $('#board-list').innerHTML = rows.map((r, i) => {
      const prevScore = prev ? prev.scores[r.idx] : r.score;
      const move = prev ? prev.ranks[r.idx] - r.rank : 0;
      const gained = r.score - prevScore;
      const moveHtml = !showMoves ? ''
        : move > 0 ? `<span class="move up">▲ ${move}</span>`
        : move < 0 ? `<span class="move down">▼ ${-move}</span>`
        : '<span class="move same">—</span>';
      const cls = r.rank <= 3 ? `rank-${r.rank}` : '';
      const crown = r.rank === 1 && r.score > 0 ? '<span class="crown-mini">👑</span>' : '';
      return `
        <li class="board-row ${cls}" data-shift="${prevPos[r.idx] - i}" style="--d:${prevPos[r.idx] * 90}ms">
          <div class="rank-badge">${r.rank}</div>
          <div class="board-main">
            <div class="board-top">
              <span class="board-name">${esc(r.name)}</span>
              ${crown}
              ${moveHtml}
              ${gained > 0 ? `<span class="gain">+${gained}</span>` : ''}
            </div>
            <div class="bar"><div class="bar-fill" style="width:${(prevScore / max) * 100}%" data-to="${(r.score / max) * 100}"></div></div>
          </div>
          <div class="board-score"><span class="num" data-from="${prevScore}" data-to="${r.score}">${prevScore}</span><small>pts</small></div>
        </li>`;
    }).join('');

    $('#btn-next').classList.toggle('hidden', isLast);
    const endBtn = $('#btn-board-end');
    endBtn.textContent = isLast ? 'Show Final Results →' : '■ End Quiz';
    endBtn.className = 'btn btn-lg ' + (isLast ? 'btn-gold' : 'btn-ghost');

    show('screen-board');
    animateBoard(rows.length);
  }

  // FLIP: rows start at their previous positions, then glide to their new ranks
  function animateBoard(count) {
    const items = $$('#board-list .board-row');
    if (!items.length) return;
    const step = items.length > 1 ? items[1].offsetTop - items[0].offsetTop : 0;
    items.forEach((row) => {
      const shift = +row.dataset.shift;
      row.style.translate = `0 ${shift * step}px`;
      if (shift > 0) row.classList.add('climbed');
    });

    const entranceDone = 500 + count * 90;
    setTimeout(() => {
      items.forEach((row) => {
        row.classList.add('moving');
        row.style.translate = '0 0';
        const fill = row.querySelector('.bar-fill');
        fill.style.width = `${fill.dataset.to}%`;
        const num = row.querySelector('.num');
        countUp(num, +num.dataset.from, +num.dataset.to, 1200);
      });
    }, entranceDone);
    setTimeout(() => {
      items.forEach((row) => {
        row.classList.remove('climbed');
        row.classList.add('settled');
      });
    }, entranceDone + 1300);
  }

  function countUp(node, from, to, duration) {
    if (from === to) { node.textContent = to; return; }
    let start = null;
    const step = (now) => {
      if (start === null) start = now;
      const p = clamp((now - start) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = Math.round(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step);
      else node.classList.add('bump');
    };
    requestAnimationFrame(step);
  }

  function nextQuestion() {
    if (busy || state.qIndex >= state.questions.length - 1) return;
    state.qIndex += 1;
    state.responses = {};
    state.phase = 'question';
    save();
    introQuestion();
  }

  // =========================================================
  // FINAL
  // =========================================================
  function requestEnd() {
    if (busy) return;
    const unplayed = state.questions.length - state.played;
    const note = state.phase === 'question' && Object.keys(state.responses).length
      ? ' Responses entered for the current question have not been submitted and will be discarded.'
      : '';
    confirmModal(
      'End the quiz now?',
      `${state.played} of ${state.questions.length} questions have been played${unplayed ? ` (${unplayed} remaining)` : ''}. The final leaderboard will be shown.${note}`,
      'End Quiz',
      finishQuiz,
      true,
    );
  }

  async function finishQuiz() {
    if (busy) return;
    busy = true;
    state.phase = 'final';
    save();
    await splash('The results are in', 'And the winner is…', 1800);
    renderFinal();
    busy = false;
  }

  function renderFinal() {
    const rows = standings();
    const winners = rows.filter((r) => r.rank === 1);
    const anyScore = rows.some((r) => r.score > 0);

    $('#final-title').innerHTML = !anyScore
      ? 'Quiz <span class="gold">Complete</span>'
      : winners.length > 1
        ? `It's a <span class="gold">tie!</span>`
        : `<span class="gold">${esc(winners[0].name)}</span> wins!`;
    $('#final-sub').textContent = winners.length > 1 && anyScore
      ? `${winners.map((w) => w.name).join(' & ')} share first place · ${state.played} question${state.played === 1 ? '' : 's'} played`
      : `${state.title} · ${state.played} question${state.played === 1 ? '' : 's'} played`;

    // Podium shown in 2nd · 1st · 3rd order
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    const top = rows.slice(0, 3);
    const order = [1, 0, 2].filter((i) => top[i]);
    const delays = { 0: 0.6, 1: 0.3, 2: 0 };
    $('#podium').innerHTML = order.map((i) => {
      const r = top[i];
      return `
        <div class="podium-place pos-${i + 1}" style="--d:${delays[i]}s">
          <div class="podium-info">
            ${r.rank === 1 && anyScore ? '<div class="crown">👑</div>' : ''}
            <div class="podium-medal">${medals[r.rank] || '🎖️'}</div>
            <div class="podium-name">${esc(r.name)}</div>
            <div class="podium-score">${r.score} pts</div>
          </div>
          <div class="podium-block">${r.rank}</div>
        </div>`;
    }).join('');

    $('#final-body').innerHTML = rows.map((r, i) => {
      const acc = state.played ? Math.round((r.correct / state.played) * 100) : 0;
      return `
        <tr class="${r.rank <= 3 ? 'r' + r.rank : ''}" style="--d:${1.2 + i * 0.08}s">
          <td><span class="rank-chip">${r.rank}</span></td>
          <td class="tname">${esc(r.name)}</td>
          <td>${r.correct} / ${state.played}</td>
          <td>${acc}%</td>
          <td class="score">${r.score}</td>
        </tr>`;
    }).join('');

    show('screen-final');
    if (anyScore) setTimeout(() => burstConfetti(280, true), 1100);
  }

  function newQuiz() {
    // Keep the previous teams pre-filled for convenience
    if (state) {
      $('#quiz-title').value = state.title;
      $('#team-count').value = state.teams.length;
      $('#team-inputs').innerHTML = '';
      renderTeamInputs();
      $$('#team-inputs input').forEach((inp, i) => { inp.value = state.teams[i].name; });
      $('#points').value = state.points;
    }
    clearSaved();
    state = null;
    $('#resume-banner').classList.add('hidden');
    show('screen-setup');
  }

  function route() {
    if (state.phase === 'question' || state.phase === 'reveal') renderQuestion();
    else if (state.phase === 'leaderboard') renderBoard();
    else renderFinal();
  }

  // =========================================================
  // FULLSCREEN
  // =========================================================
  // Browsers always leave fullscreen on Esc, printing or a page reload. If that
  // happens mid-quiz, a small "Return to fullscreen" button offers a one-click way back.
  let fsWanted = false;
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

  function enterFullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    fsWanted = true;
    try {
      const p = req.call(el);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* not allowed */ }
  }
  function exitFullscreen() {
    fsWanted = false;
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex && fsElement()) ex.call(document);
  }
  function onFullscreenChange() {
    const on = !!fsElement();
    $('#btn-fullscreen').textContent = on ? '⤡ Exit Fullscreen' : '⛶ Fullscreen';
    $('#fs-return').classList.toggle('hidden', on || !fsWanted);
  }

  // =========================================================
  // CONFETTI & AMBIENT EFFECTS
  // =========================================================
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  let particles = [];
  let rafId = null;
  const COLORS = ['#e3b75a', '#f7dc95', '#5b7cfa', '#a26bfa', '#22c58b', '#ffffff', '#f59e0b'];

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function burstConfetti(count, grand = false) {
    if (reducedMotion()) return;
    const spawn = (x, n) => {
      for (let i = 0; i < n; i++) {
        particles.push({
          x, y: innerHeight + 10,
          vx: (Math.random() - 0.5) * 9,
          vy: -(Math.random() * 11 + 9),
          w: Math.random() * 8 + 5, h: Math.random() * 5 + 3,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          life: 0,
        });
      }
    };
    spawn(innerWidth * 0.15, count / 2);
    spawn(innerWidth * 0.85, count / 2);
    if (grand) {
      setTimeout(() => spawn(innerWidth * 0.5, count / 2), 500);
      setTimeout(() => { spawn(innerWidth * 0.3, count / 3); spawn(innerWidth * 0.7, count / 3); }, 1100);
    }
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    particles = particles.filter((p) => p.y < innerHeight + 40 && p.life < 400);
    for (const p of particles) {
      p.life++;
      p.vy += 0.28; p.vx *= 0.99; p.vy *= 0.99;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life * 0.1)));
      ctx.restore();
    }
    rafId = particles.length ? requestAnimationFrame(tick) : null;
    if (!rafId) ctx.clearRect(0, 0, innerWidth, innerHeight);
  }

  function makeStars(n) {
    const wrap = $('#stars');
    let html = '';
    for (let i = 0; i < n; i++) {
      html += `<span style="left:${Math.random() * 100}%;top:${Math.random() * 100}%;--s:${(Math.random() * 2 + 1).toFixed(1)}px;--t:${(3 + Math.random() * 5).toFixed(1)}s;--d:${(-Math.random() * 8).toFixed(1)}s"></span>`;
    }
    wrap.innerHTML = html;
  }

  // Ripple feedback on buttons
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn, .choice');
    if (!b || b.disabled || reducedMotion()) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.appendChild(s);
    setTimeout(() => s.remove(), 650);
  });

  // =========================================================
  // EVENTS
  // =========================================================
  $$('.stepper button').forEach((b) => b.addEventListener('click', () => {
    const inp = $('#team-count');
    inp.value = clamp((parseInt(inp.value, 10) || MIN_TEAMS) + +b.dataset.step, MIN_TEAMS, MAX_TEAMS);
    renderTeamInputs();
  }));
  $('#team-count').addEventListener('change', renderTeamInputs);
  $('#btn-start').addEventListener('click', startQuiz);
  $('#btn-resume').addEventListener('click', () => {
    state = loadSaved();
    $('#resume-banner').classList.add('hidden');
    if (state) route();
  });
  $('#btn-discard').addEventListener('click', () => { clearSaved(); $('#resume-banner').classList.add('hidden'); });

  $('#team-responses').addEventListener('click', onChoiceClick);
  $('#btn-submit').addEventListener('click', submitAnswers);
  $('#btn-undo').addEventListener('click', undoReveal);
  $('#btn-to-board').addEventListener('click', renderBoard);

  $('#btn-next').addEventListener('click', nextQuestion);
  $('#btn-board-end').addEventListener('click', () => {
    if (state.qIndex >= state.questions.length - 1) finishQuiz();
    else requestEnd();
  });
  $('#btn-end').addEventListener('click', requestEnd);

  $('#btn-new').addEventListener('click', newQuiz);
  $('#btn-print').addEventListener('click', () => window.print());

  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#modal-ok').addEventListener('click', () => { const fn = modalAction; closeModal(); if (fn) fn(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
  });

  $('#btn-fullscreen').addEventListener('click', (e) => {
    if (fsElement()) exitFullscreen(); else enterFullscreen();
    // Don't keep focus here: a later Space/Enter keypress would toggle fullscreen off
    e.currentTarget.blur();
  });
  $('#fs-return-btn').addEventListener('click', enterFullscreen);
  $('#fs-return-close').addEventListener('click', () => { fsWanted = false; $('#fs-return').classList.add('hidden'); });
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  // Every button blurs after a mouse click so stray key presses can't re-trigger it
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && e.detail > 0) b.blur();
  });

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  makeStars(70);
  initSetup();
})();

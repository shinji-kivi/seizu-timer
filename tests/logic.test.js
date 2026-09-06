// index.html のロジックを Node 上で検証する。
// 単一 HTML なので <script> の中身を抜き出し、最小限の DOM / localStorage スタブを噛ませて vm で実行する。
//
//   node tests/logic.test.js
//
// 目的は「工程セット（テンプレート）の複数保存」と「工程 id による履歴の突き合わせ」が
// 過去の記録を壊さないことの確認。DOM の見た目は対象外（それは実ブラウザで確認する）。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX = path.join(__dirname, '..', 'index.html');

// ---------------------------------------------------------------- DOM スタブ

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.style = { setProperty() {}, getPropertyValue() { return ''; } };
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    this._text = '';
    this._html = '';
    this.value = '';
    this.disabled = false;
    this.selected = false;
    this.draggable = false;
  }
  // escapeText() が textContent → innerHTML の変換に依存しているので、その挙動まで真似る
  get textContent() { return this._text; }
  set textContent(v) {
    this._text = (v === null || v === undefined) ? '' : String(v);
    this._html = escapeHtml(this._text);
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  remove() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  getAttribute() { return null; }
  focus() {}
  click() {}
}

function makeLocalStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
    _dump() { return Object.fromEntries(map); }
  };
}

// 抽出した <script> の末尾に、テストから触りたい名前を context へ出す行を足す。
// top-level の const / let は vm の context には載らないため、明示的に渡す必要がある
const EXPORTED = [
  'DEFAULT_TEMPLATES', 'DEFAULT_TEMPLATE_NAMES', 'PRESET_TEMPLATES', 'DEFAULT_STEP_ID_BY_NAME',
  'MODES', 'STORAGE_KEYS', 'APP_VERSION',
  'defaultTemplateId', 'newStepId', 'dedupeStepIds', 'buildDefaultTemplateStore',
  'validateTemplates', 'migrateTemplatesV1', 'getTemplates', 'saveTemplates',
  'templatesOfMode', 'findTemplate', 'getActiveTemplate', 'setActiveTemplate',
  'sessionTemplateId', 'sessionTemplateName', 'stepKey', 'uniqueTemplateName',
  'getSessions', 'saveSessions', 'getStats', 'saveStats', 'getBestTotal', 'recalcStats',
  'buildStepLabels', 'renderCompare', 'renderRatingAnalysis', 'validateImport',
  'saveSession', 'lap', 'finishSession',
  'BACKUP_NOTICE_EVERY', 'getBackupBaseline', 'setBackupBaseline', 'shouldNoticeBackup',
  'renderBackupNotice', 'dismissBackupNotice', 'renderHome',
  'startSetupWithMode', 'confirmFinish', 'askFinishConfirm',
  'sessionStars', 'starsText', 'starInputHtml', 'starsBadge', 'matchStarFilter',
  'setSessionStars', 'updateSessionStars', 'showSessionDetail', 'saveActiveSession',
  'renderHistory',
  'HEATMAP_DAYS', 'dateKey', 'buildDailyTotals', 'heatLevel', 'buildHeatmapCells',
  'buildTotals', 'heatCellText', 'renderHeatmap'
];

function extractScript() {
  const src = fs.readFileSync(INDEX, 'utf8');
  const blocks = src.match(/<script>([\s\S]*?)<\/script>/g) || [];
  if (blocks.length !== 1) throw new Error('想定外: <script> ブロックが ' + blocks.length + ' 個');
  return blocks[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
}

const SCRIPT_BODY = extractScript();

// localStorage の中身を指定してアプリを1つ立ち上げる。テストごとに新品を使う
function loadApp(seed) {
  const els = {};
  const documentStub = {
    getElementById(id) { if (!els[id]) els[id] = new FakeEl(id); return els[id]; },
    createElement(tag) { return new FakeEl(tag); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: new FakeEl('body'),
    documentElement: new FakeEl('html'),
    visibilityState: 'visible'
  };
  const ctx = {
    document: documentStub,
    window: { addEventListener() {}, scrollTo() {} },
    navigator: {},
    location: { pathname: '/index.html' },
    localStorage: makeLocalStorage(seed),
    performance: { now: () => 0 },
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Blob: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    FileReader: function () {}
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const tail = '\nglobalThis.__app = { ' +
    EXPORTED.map(n => n + ': ' + n).join(', ') +
    ', setTimerState: (s) => { timerState = s; }, getTimerState: () => timerState };\n';
  vm.runInContext(SCRIPT_BODY + tail, ctx, { filename: 'index.html<script>' });
  const app = ctx.__app;
  app._els = els;
  app._storage = ctx.localStorage;
  // 確認ダイアログを差し替えるために context 自体を渡す。
  // top-level の function 宣言は const/let と違って context のプロパティになるので、
  // ctx.askConfirm を上書きすれば呼び出し側（lap など）から見えるものも入れ替わる
  app._ctx = ctx;
  return app;
}

// ---------------------------------------------------------------- テスト土台

let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}
// 確認ダイアログを挟む処理は非同期なので、末尾でまとめて await する
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }

function ok(cond, msg) {
  if (!cond) throw new Error(msg || '条件が成立しませんでした');
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + '期待 ' + b + ' / 実際 ' + a);
}

// ---------------------------------------------------------------- 固定データ

// v1.2.0 以前の保存形式（工程セットの概念なし・工程名だけ）
const V1_TEMPLATES = {
  full: [{ name: '問題文読み取り', targetTime: 1800 }],
  esquisse: [{ name: '問題文読み取り', targetTime: 1800 }],
  drawing: [
    { name: 'STEP1 通り心', targetTime: 600 },
    { name: '面積表', targetTime: 240 }
  ],
  writing: [{ name: '記述（計画の要点等）', targetTime: 3600 }]
};

function legacySession(over) {
  // v1.2.0 以前に保存された記録。templateId も工程 id も持たない
  return Object.assign({
    id: 'old1', date: '2026-07-01T02:00:00.000Z', taskName: '課題A',
    mode: 'drawing', totalTime: 6000, completed: true,
    steps: [
      { name: '面積表', targetTime: 240, actualTime: 300, rating: 'good', memo: '' },
      { name: '通り心・寸法線（各階同時）', targetTime: 360, actualTime: 400, rating: 'bad', memo: '' }
    ]
  }, over || {});
}

function newSession(over) {
  // v1.3.0 以降の記録。工程 id と工程セット id を持つ
  return Object.assign({
    id: 'new1', date: '2026-08-10T02:00:00.000Z', taskName: '課題B',
    mode: 'drawing', templateId: 'tpl_drawing_default', templateName: '本番想定（180分）',
    totalTime: 5000, completed: true,
    steps: [
      { id: 's_area', name: '面積表（改）', targetTime: 240, actualTime: 200, rating: 'good', memo: '' },
      { id: 's_grid', name: '通り心・寸法線（各階同時）', targetTime: 360, actualTime: 380, rating: 'good', memo: '' }
    ]
  }, over || {});
}

function seedWith(sessions, templates) {
  const seed = { seizu_sessions: JSON.stringify(sessions) };
  if (templates) seed.seizu_templates = JSON.stringify(templates);
  return seed;
}

// ================================================================ 1. 既定データ

test('既定の工程はすべて id を持ち、同じ工程名なら id も同じ', () => {
  const app = loadApp();
  const byName = {};
  Object.keys(app.DEFAULT_TEMPLATES).forEach(m => {
    app.DEFAULT_TEMPLATES[m].forEach(s => {
      ok(typeof s.id === 'string' && s.id.length > 0, m + ' の「' + s.name + '」に id が無い');
      if (byName[s.name]) eq(s.id, byName[s.name], '同名工程「' + s.name + '」の id が食い違う');
      byName[s.name] = s.id;
    });
  });
  eq(app.DEFAULT_STEP_ID_BY_NAME['面積表'], 's_area');
  eq(app.DEFAULT_STEP_ID_BY_NAME['記述（計画の要点等）'], 's_writing');
});

test('1つの工程セット内で工程 id が重複しない', () => {
  const app = loadApp();
  Object.keys(app.DEFAULT_TEMPLATES).forEach(m => {
    const ids = app.DEFAULT_TEMPLATES[m].map(s => s.id);
    eq(new Set(ids).size, ids.length, m + ' に重複 id がある');
  });
  Object.keys(app.PRESET_TEMPLATES).forEach(m => {
    app.PRESET_TEMPLATES[m].forEach(p => {
      const ids = p.steps.map(s => s.id);
      eq(new Set(ids).size, ids.length, p.name + ' に重複 id がある');
    });
  });
});

test('プリセットの合計時間が想定どおり（タイムトライアル60分・大枠390分）', () => {
  const app = loadApp();
  const tt = app.PRESET_TEMPLATES.drawing.find(p => p.name.indexOf('タイムトライアル') !== -1);
  ok(tt, '作図タイムトライアルのプリセットが無い');
  eq(tt.steps.reduce((a, s) => a + s.targetTime, 0) / 60, 60);
  eq(tt.steps.length, 5);
  const rough = app.PRESET_TEMPLATES.full[0];
  eq(rough.steps.reduce((a, s) => a + s.targetTime, 0) / 60, 390);
});

// ================================================================ 2. 形式チェック

test('validateTemplates は正しい v2 だけを通す', () => {
  const app = loadApp();
  const store = app.buildDefaultTemplateStore();
  ok(app.validateTemplates(store), '既定ストアが通らない');

  ok(!app.validateTemplates(null));
  ok(!app.validateTemplates(V1_TEMPLATES), 'v1 形式を通してしまった');

  const noVersion = JSON.parse(JSON.stringify(store)); delete noVersion.version;
  ok(!app.validateTemplates(noVersion));

  const dupTpl = JSON.parse(JSON.stringify(store));
  dupTpl.list.push(JSON.parse(JSON.stringify(dupTpl.list[0])));
  ok(!app.validateTemplates(dupTpl), 'セット id の重複を通してしまった');

  const dupStep = JSON.parse(JSON.stringify(store));
  dupStep.list[0].steps.push(JSON.parse(JSON.stringify(dupStep.list[0].steps[0])));
  ok(!app.validateTemplates(dupStep), '工程 id の重複を通してしまった');

  const badActive = JSON.parse(JSON.stringify(store));
  badActive.active.drawing = 'tpl_does_not_exist';
  ok(!app.validateTemplates(badActive), '存在しない使用中セットを通してしまった');

  const noSteps = JSON.parse(JSON.stringify(store));
  noSteps.list[0].steps = [];
  ok(!app.validateTemplates(noSteps));

  const badTime = JSON.parse(JSON.stringify(store));
  badTime.list[0].steps[0].targetTime = 0;
  ok(!app.validateTemplates(badTime));

  const noId = JSON.parse(JSON.stringify(store));
  delete noId.list[0].steps[0].id;
  ok(!app.validateTemplates(noId), '工程 id 無しを通してしまった');
});

test('dedupeStepIds は重複した工程 id を振り直す', () => {
  const app = loadApp();
  const out = app.dedupeStepIds([
    { id: 's_area', name: 'A', targetTime: 60 },
    { id: 's_area', name: 'B', targetTime: 60 },
    { id: '', name: 'C', targetTime: 60 }
  ]);
  eq(out.length, 3);
  eq(out[0].id, 's_area');
  ok(out[1].id !== 's_area', '2つ目の id が振り直されていない');
  ok(out[2].id, '空 id が埋められていない');
  eq(new Set(out.map(s => s.id)).size, 3);
});

test('uniqueTemplateName は同名を避けて番号を足す', () => {
  const app = loadApp();
  const store = app.buildDefaultTemplateStore();
  eq(app.uniqueTemplateName('本番想定（180分）', 'drawing', store), '本番想定（180分） 2');
  eq(app.uniqueTemplateName('新しい工程セット', 'drawing', store), '新しい工程セット');
});

// ================================================================ 3. v1 からの移行

test('v1 の工程テンプレートは v2 の工程セットへ移行される', () => {
  const app = loadApp();
  const store = app.migrateTemplatesV1(V1_TEMPLATES);
  ok(app.validateTemplates(store), '移行結果が形式チェックを通らない');
  app.MODES.forEach(m => {
    eq(app.templatesOfMode(store, m).length, 1, m + ' のセット数');
    eq(store.active[m], app.defaultTemplateId(m));
  });
  const drawing = app.findTemplate('tpl_drawing_default', store);
  eq(drawing.steps.length, 2);
  // 既定の工程名は固定 id に引き当てられる（過去の記録と繋がるようにするため）
  eq(drawing.steps[1].id, 's_area');
  eq(drawing.steps[1].targetTime, 240);
  // 利用者が付けた名前は新しい id（u_ 始まり）
  ok(drawing.steps[0].id.indexOf('u_') === 0, '独自工程に u_ の id が振られていない: ' + drawing.steps[0].id);
  eq(drawing.steps[0].name, 'STEP1 通り心');
});

test('getTemplates は v1 を自動移行し、壊れたデータは既定に戻す', () => {
  const v1 = loadApp({ seizu_templates: JSON.stringify(V1_TEMPLATES) });
  const t1 = v1.getTemplates();
  ok(v1.validateTemplates(t1));
  eq(v1.findTemplate('tpl_drawing_default', t1).steps.length, 2);

  const broken = loadApp({ seizu_templates: '{"full":"こわれている"}' });
  const t2 = broken.getTemplates();
  ok(broken.validateTemplates(t2));
  eq(t2.list.length, 4);

  const garbage = loadApp({ seizu_templates: 'not json' });
  ok(garbage.validateTemplates(garbage.getTemplates()));

  const fresh = loadApp();
  eq(fresh.getTemplates().list.length, 4);
});

test('起動時に v1 が v2 として書き戻される（毎回変換し直さない）', () => {
  const app = loadApp({ seizu_templates: JSON.stringify(V1_TEMPLATES) });
  const stored = JSON.parse(app._storage.getItem('seizu_templates'));
  eq(stored.version, 2, '保存済みデータが v2 に更新されていない');
  ok(app.validateTemplates(stored));
});

// ================================================================ 4. 突き合わせキー

test('stepKey は id / 既定工程名の逆引き / 工程名 の順で決まる', () => {
  const app = loadApp();
  eq(app.stepKey({ id: 'u_abc', name: '面積表' }), 'u_abc', 'id があれば id を使う');
  eq(app.stepKey({ name: '面積表' }), 's_area', '既定工程名は固定 id へ');
  eq(app.stepKey({ name: '独自の工程' }), 'name:独自の工程', '未知の名前は名前のまま');
  eq(app.stepKey({}), 'name:');
});

test('id を持たない過去の記録が、新しい記録と同じ工程として合流する', () => {
  const app = loadApp(seedWith([legacySession(), newSession()]));
  app.renderCompare(app.getSessions());
  const html = app._els['compare-content'].innerHTML;
  // 工程は2種類（面積表・通り心）。名前が違っても id で1つにまとまる
  eq((html.match(/class="card"/g) || []).length, 2, '工程が分かれてしまっている');
  ok(html.indexOf('面積表（改）') !== -1, '最新の工程名で表示されていない');
  ok(html.indexOf('>面積表<') === -1, '旧名の別カードが残っている');
  // 平均は 300 と 200 の平均 = 250 秒 → 4:10
  ok(html.indexOf('4:10') !== -1, '両方の記録が平均に入っていない: ' + html.slice(0, 200));
});

test('工程名だけで記録された独自工程は、id を振った後の記録とは合流しない（既知の限界）', () => {
  const legacy = legacySession({ steps: [{ name: '独自工程', targetTime: 600, actualTime: 700, rating: 'good', memo: '' }] });
  const fresh = newSession({ steps: [{ id: 'u_zzz', name: '独自工程', targetTime: 600, actualTime: 500, rating: 'good', memo: '' }] });
  const app = loadApp(seedWith([legacy, fresh]));
  app.renderCompare(app.getSessions());
  const html = app._els['compare-content'].innerHTML;
  eq((html.match(/class="card"/g) || []).length, 2, '独自工程が合流してしまった（仕様上は別扱い）');
});

test('評価分析も id で突き合わせる', () => {
  const app = loadApp(seedWith([legacySession(), newSession()]));
  app.renderRatingAnalysis(app.getSessions());
  const html = app._els['rating-content'].innerHTML;
  eq((html.match(/class="card"/g) || []).length, 2);
  // 通り心は 旧 bad / 新 good → Good率 50%
  ok(html.indexOf('50%') !== -1, 'Good率が合算されていない');
});

test('buildStepLabels は最新の記録の工程名を採る', () => {
  const app = loadApp();
  const labels = app.buildStepLabels([legacySession(), newSession()]);
  eq(labels['s_area'], '面積表（改）');
});

// ================================================================ 5. 工程セット単位の集計

test('工程セット導入前の記録は、そのモードの既定セット扱いになる', () => {
  const app = loadApp();
  eq(app.sessionTemplateId(legacySession()), 'tpl_drawing_default');
  eq(app.sessionTemplateId(newSession({ templateId: 'tpl_x' })), 'tpl_x');
});

test('削除済みの工程セットの記録は、控えてある名前で表示される', () => {
  const app = loadApp();
  const store = app.getTemplates();
  const s = newSession({ templateId: 'tpl_gone', templateName: '作図タイムトライアル（60分）' });
  eq(app.sessionTemplateName(s, store), '作図タイムトライアル（60分）');
  // セットが実在すればそちらの名前（改名に追従する）
  eq(app.sessionTemplateName(newSession(), store), '本番想定（180分）');
});

test('ベストタイムは工程セットごとに分かれる', () => {
  const sessions = [
    newSession({ id: 'a', templateId: 'tpl_drawing_default', totalTime: 10000 }),
    newSession({ id: 'b', templateId: 'tpl_drawing_default', totalTime: 9000 }),
    newSession({ id: 'c', templateId: 'tpl_tt', templateName: 'TT', totalTime: 3600 })
  ];
  const app = loadApp(seedWith(sessions));
  const stats = app.recalcStats();
  eq(app.getBestTotal(stats, 'tpl_drawing_default'), 9000, '本番想定のベストが短い記録に奪われている');
  eq(app.getBestTotal(stats, 'tpl_tt'), 3600);
  eq(app.getBestTotal(stats, 'tpl_none'), null);
  eq(stats.version, 2);
  eq(stats.totalSessions, 3);
});

test('途中終了した回はベストタイムに数えない', () => {
  const app = loadApp(seedWith([
    newSession({ id: 'a', totalTime: 9000, completed: true }),
    newSession({ id: 'b', totalTime: 1000, completed: false })
  ]));
  eq(app.getBestTotal(app.recalcStats(), 'tpl_drawing_default'), 9000);
});

test('completed を持たない過去の記録はベストの対象に含める', () => {
  const s = legacySession({ totalTime: 8000 });
  delete s.completed;
  const app = loadApp(seedWith([s]));
  eq(app.getBestTotal(app.recalcStats(), 'tpl_drawing_default'), 8000);
});

test('工程ごとのベストは stepKey で集約される', () => {
  const app = loadApp(seedWith([legacySession(), newSession()]));
  const stats = app.recalcStats();
  const bt = stats.bestTimes['tpl_drawing_default'];
  eq(bt.steps['s_area'], 200, '旧記録(300)と新記録(200)が同じキーに入っていない');
  eq(bt.steps['s_grid'], 380);
});

test('getBestTotal は JSON 化で null になったベストを弾く', () => {
  const app = loadApp();
  eq(app.getBestTotal({ bestTimes: { x: { total: null } } }, 'x'), null);
  eq(app.getBestTotal({ bestTimes: {} }, 'x'), null);
  eq(app.getBestTotal(null, 'x'), null);
  eq(app.getBestTotal({ bestTimes: { x: { total: 120 } } }, 'x'), 120);
});

// ================================================================ 6. 工程セットの操作

test('使用中の工程セットを切り替えて保存できる', () => {
  const app = loadApp();
  const store = app.getTemplates();
  const tt = { id: 'tpl_tt', mode: 'drawing', name: 'TT', steps: [{ id: 's_tt1', name: 'STEP1', targetTime: 600 }] };
  store.list.push(tt);
  app.saveTemplates(store);

  eq(app.getActiveTemplate('drawing').id, 'tpl_drawing_default');
  ok(app.setActiveTemplate('drawing', 'tpl_tt'));
  eq(app.getActiveTemplate('drawing').id, 'tpl_tt');
  // モードが違うセットは指定できない
  ok(!app.setActiveTemplate('full', 'tpl_tt'));
  eq(app.getActiveTemplate('full').id, 'tpl_full_default');
});

test('使用中の指定が壊れていても、そのモードの先頭セットに落ちる', () => {
  const app = loadApp();
  const store = app.buildDefaultTemplateStore();
  store.active.drawing = 'tpl_missing';
  eq(app.getActiveTemplate('drawing', store).id, 'tpl_drawing_default');
});

// ================================================================ 7. 保存とインポート

test('ラップした工程に工程 id が引き継がれる', () => {
  const app = loadApp();
  const tpl = app.findTemplate('tpl_drawing_default');
  app.setTimerState({
    running: true, paused: false, mode: 'drawing',
    templateId: tpl.id, templateName: tpl.name,
    taskName: '課題D', memo: '', steps: JSON.parse(JSON.stringify(tpl.steps.slice(0, 3))),
    currentStep: 0, totalElapsed: 0, stepElapsed: 120,
    intervalId: null, laps: [], clockStart: null
  });
  app.lap();
  app.lap();
  app.finishSession(true);
  app.saveSession();
  const saved = app.getSessions()[0];
  eq(saved.steps.map(s => s.id), ['s_area', 's_grid', 's_column'],
    'ラップ / 終了時に工程 id が落ちている');
});

test('保存した記録に工程セット id と工程 id が入る', () => {
  const app = loadApp();
  app.setTimerState({
    running: false, paused: false, mode: 'drawing',
    templateId: 'tpl_drawing_default', templateName: '本番想定（180分）',
    taskName: '課題C', memo: 'めも', totalElapsed: 4000, completed: true,
    laps: [
      { id: 's_area', name: '面積表', targetTime: 240, actualTime: 250, rating: 'good', memo: '' },
      { name: '通り心・寸法線（各階同時）', targetTime: 360, actualTime: 300, rating: 'good', memo: '' }
    ]
  });
  app.saveSession();
  const saved = app.getSessions();
  eq(saved.length, 1);
  eq(saved[0].templateId, 'tpl_drawing_default');
  eq(saved[0].templateName, '本番想定（180分）');
  eq(saved[0].steps[0].id, 's_area');
  // id を持たないラップでも、工程名から既定 id を引き当てて保存する
  eq(saved[0].steps[1].id, 's_grid');
  eq(saved[0].completed, true);
});

// ================================================================ 8. バックアップの案内

function manySessions(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(newSession({ id: 's' + i }));
  return out;
}

test('記録が10件たまるまで案内は出ない', () => {
  const app = loadApp(seedWith(manySessions(9)));
  eq(app.BACKUP_NOTICE_EVERY, 10);
  ok(!app.shouldNoticeBackup(9));
  ok(app.shouldNoticeBackup(10));
  ok(app.shouldNoticeBackup(11));
});

test('一度も控えていない既存利用者には初回から案内が出る', () => {
  const app = loadApp(seedWith(manySessions(30)));
  eq(app.getBackupBaseline(), 0, '未設定なら基準は0');
  ok(app.shouldNoticeBackup(30));
  app.renderHome();
  const el = app._els['backup-notice'];
  eq(el.style.display, '', '案内が表示されていない');
  ok(app._els['backup-notice-text'].textContent.indexOf('30件') !== -1,
    '件数が本文に出ていない: ' + app._els['backup-notice-text'].textContent);
});

test('「あとで」を押すと引っ込み、さらに10件たまるまで出ない', () => {
  const app = loadApp(seedWith(manySessions(12)));
  app.renderHome();
  eq(app._els['backup-notice'].style.display, '');
  app.dismissBackupNotice();
  eq(app._els['backup-notice'].style.display, 'none');
  eq(app.getBackupBaseline(), 12, '基準が現在の件数に更新されていない');
  ok(!app.shouldNoticeBackup(12));
  ok(!app.shouldNoticeBackup(21), '10件たまる前に再表示されている');
  ok(app.shouldNoticeBackup(22));
});

test('基準は localStorage に残り、次の起動でも引き継がれる', () => {
  const app = loadApp(seedWith(manySessions(15)));
  app.setBackupBaseline(15);
  const saved = app._storage.getItem('seizu_backup_at');
  eq(saved, '15');
  const restarted = loadApp(Object.assign(seedWith(manySessions(15)), { seizu_backup_at: '15' }));
  eq(restarted.getBackupBaseline(), 15);
  ok(!restarted.shouldNoticeBackup(15));
  restarted.renderHome();
  eq(restarted._els['backup-notice'].style.display, 'none');
});

test('記録を削除して基準を下回っても案内は出ない', () => {
  const app = loadApp(Object.assign(seedWith(manySessions(3)), { seizu_backup_at: '20' }));
  ok(!app.shouldNoticeBackup(3));
  app.renderHome();
  eq(app._els['backup-notice'].style.display, 'none');
});

test('壊れた基準値は0として扱う（案内が出なくなるより出るほうが安全）', () => {
  ['', 'abc', '-5', 'NaN'].forEach(v => {
    const app = loadApp({ seizu_backup_at: v });
    eq(app.getBackupBaseline(), 0, '入力 "' + v + '"');
  });
  const ok10 = loadApp({ seizu_backup_at: '10' });
  eq(ok10.getBackupBaseline(), 10);
});

test('validateImport は工程 id の無い旧バックアップも受け付ける', () => {
  const app = loadApp();
  ok(app.validateImport({ sessions: [legacySession()] }), '旧形式の記録を弾いてしまった');
  ok(app.validateImport({ sessions: [newSession()] }));
  ok(!app.validateImport({ sessions: [Object.assign(legacySession(), { mode: 'unknown' })] }));
  ok(!app.validateImport({}));
});

// ================================================================ 8. ホームのタイルから開始（v1.5.0）

test('ホームのタイルを押すと、そのモードを選んだ状態でセッション設定が開く', () => {
  const app = loadApp();
  app.startSetupWithMode('drawing');
  eq(app._els['setup-mode'].value, 'drawing');
  app.startSetupWithMode('writing');
  eq(app._els['setup-mode'].value, 'writing');
});

test('存在しないモードを渡してもモードの選択を書き換えない', () => {
  const app = loadApp();
  app.startSetupWithMode('full');
  app.startSetupWithMode('unknown');
  eq(app._els['setup-mode'].value, 'full');
});

// ================================================================ 9. 完了・終了の確認（v1.5.0）

// 3工程・最終工程まで進めた状態を作る
function timerAtLastStep(app) {
  const tpl = app.findTemplate('tpl_drawing_default');
  app.setTimerState({
    running: true, paused: false, mode: 'drawing',
    templateId: tpl.id, templateName: tpl.name,
    taskName: '課題E', memo: '', steps: JSON.parse(JSON.stringify(tpl.steps.slice(0, 3))),
    currentStep: 2, totalElapsed: 1000, stepElapsed: 300,
    intervalId: null, laps: [
      { id: 's_area', name: '面積表', targetTime: 240, actualTime: 250, rating: null, memo: '' },
      { id: 's_grid', name: '通り心', targetTime: 360, actualTime: 450, rating: null, memo: '' }
    ], clockStart: null
  });
  return app;
}

testAsync('最終工程の「完了」をキャンセルすると計測が続く', async () => {
  const app = timerAtLastStep(loadApp());
  app._ctx.askConfirm = () => Promise.resolve(false);
  await app.lap();
  const st = app.getTimerState();
  ok(st.running, '計測が止まってしまった');
  eq(st.laps.length, 2, 'キャンセルしたのに工程が記録された');
});

testAsync('最終工程の「完了」を承認すると完走として確定する', async () => {
  const app = timerAtLastStep(loadApp());
  app._ctx.askConfirm = () => Promise.resolve(true);
  await app.lap();
  const st = app.getTimerState();
  ok(!st.running, '計測が止まっていない');
  ok(st.completed, '完走として記録されていない');
  eq(st.laps.length, 3);
  eq(st.laps[2].id, 's_column');
});

testAsync('確認している間に過ぎた時間は記録に加算しない', async () => {
  const app = timerAtLastStep(loadApp());
  // ダイアログを開いている間もタイマーは進む。その状況を作ってから OK を返す
  app._ctx.askConfirm = () => {
    const st = app.getTimerState();
    st.totalElapsed += 8;
    st.stepElapsed += 8;
    return Promise.resolve(true);
  };
  await app.lap();
  const st = app.getTimerState();
  eq(st.totalElapsed, 1000, '確認中の時間が合計に乗った');
  eq(st.laps[2].actualTime, 300, '確認中の時間が最終工程の実績に乗った');
});

testAsync('「終了」もキャンセルできる。承認すると途中終了として記録する', async () => {
  const cancelled = timerAtLastStep(loadApp());
  cancelled._ctx.askConfirm = () => Promise.resolve(false);
  await cancelled.confirmFinish();
  ok(cancelled.getTimerState().running, 'キャンセルしたのに終了した');

  const app = timerAtLastStep(loadApp());
  app._ctx.askConfirm = () => Promise.resolve(true);
  await app.confirmFinish();
  const st = app.getTimerState();
  ok(!st.running, '終了していない');
  eq(st.completed, false, '「終了」経由なのに完走扱いになっている');
});

// ================================================================ 10. セッション全体の星評価（v1.6.0）

test('星の値は 1〜5 に正規化し、それ以外は未評価（0）として扱う', () => {
  const app = loadApp();
  // 星を入れる前に保存した記録（stars 自体が無い）
  eq(app.sessionStars(legacySession()), 0);
  eq(app.sessionStars({ stars: 0 }), 0);
  eq(app.sessionStars({ stars: 3 }), 3);
  eq(app.sessionStars({ stars: 5 }), 5);
  // 範囲外・型違いは未評価に倒す（壊れたデータで表示が崩れないように）
  eq(app.sessionStars({ stars: 6 }), 0);
  eq(app.sessionStars({ stars: -1 }), 0);
  eq(app.sessionStars({ stars: '4' }), 0);
  eq(app.sessionStars(null), 0);
  eq(app.starsText(3), '\u2605\u2605\u2605');
  eq(app.starsText(0), '');
});

test('星の入力欄は5個のボタンを出し、現在値の数だけ on が付く', () => {
  const app = loadApp();
  const html = app.starInputHtml(3, 'setSessionStars');
  eq((html.match(/<button/g) || []).length, 5);
  eq((html.match(/star-btn on/g) || []).length, 3);
  // 履歴詳細からはセッション id を第1引数に渡す
  const withId = app.starInputHtml(0, 'updateSessionStars', 'abc1');
  ok(withId.indexOf("updateSessionStars('abc1',1)") !== -1, 'id が呼び出しに載っていない');
  eq((withId.match(/star-btn on/g) || []).length, 0);
});

test('振り返りで付けた星が保存され、中断データにも載る', () => {
  const app = loadApp();
  app.setTimerState({
    running: false, paused: false, mode: 'drawing',
    templateId: 'tpl_drawing_default', templateName: '本番想定（180分）',
    taskName: '課題F', memo: '', totalElapsed: 4000, completed: true, stars: 0,
    steps: [], currentStep: 0, stepElapsed: 0, laps: [
      { id: 's_area', name: '面積表', targetTime: 240, actualTime: 250, rating: 'good', memo: '' }
    ], clockStart: null
  });
  app.setSessionStars(4);
  eq(app.getTimerState().stars, 4);
  // 中断して開き直しても星が残るよう、復元用データにも入れる
  const active = JSON.parse(app._storage.getItem('seizu_active_session'));
  eq(active.stars, 4);
  app.saveSession();
  eq(app.getSessions()[0].stars, 4);
});

test('同じ星をもう一度押すと取り消される', () => {
  const app = loadApp();
  app.setTimerState({
    running: false, paused: false, mode: 'drawing',
    templateId: 'tpl_drawing_default', templateName: '', taskName: '課題G', memo: '',
    totalElapsed: 100, completed: true, stars: 0, steps: [], currentStep: 0,
    stepElapsed: 0, laps: [], clockStart: null
  });
  app.setSessionStars(5);
  eq(app.getTimerState().stars, 5);
  app.setSessionStars(5);
  eq(app.getTimerState().stars, 0, '同じ星で取り消しにならない');
  app.setSessionStars(2);
  eq(app.getTimerState().stars, 2);
});

test('星を付けずに保存した回は 0 で記録される（旧記録と同じ扱い）', () => {
  const app = loadApp();
  app.setTimerState({
    running: false, paused: false, mode: 'writing',
    templateId: 'tpl_writing_default', templateName: '', taskName: '課題H', memo: '',
    totalElapsed: 3000, completed: true, steps: [], currentStep: 0, stepElapsed: 0,
    laps: [{ id: 's_writing', name: '記述', targetTime: 3600, actualTime: 3000, rating: 'good', memo: '' }],
    clockStart: null
  });
  app.saveSession();
  eq(app.getSessions()[0].stars, 0);
});

test('履歴カードには星が並び、未評価の回には出ない', () => {
  // 履歴は保存された順の逆（新しい順）に並ぶので、後ろに置いた回が先頭に来る
  const app = loadApp(seedWith([
    legacySession({ id: 'b' }),
    newSession({ id: 'a', stars: 4 })
  ]));
  eq(app.starsBadge({ stars: 4 }).indexOf('\u2605\u2605\u2605\u2605') !== -1, true);
  eq(app.starsBadge(legacySession()), '');
  app.renderHistory();
  const cards = app._els['history-list'].children;
  eq(cards.length, 2);
  // 新しい順に並ぶので先頭が星付きの回
  ok(cards[0].innerHTML.indexOf('stars-badge') !== -1, '星付きの回にバッジが出ていない');
  ok(cards[1].innerHTML.indexOf('stars-badge') === -1, '未評価の回にバッジが出ている');
});

testAsync('履歴の詳細から星を後付けでき、もう一度押すと取り消せる', async () => {
  const app = loadApp(seedWith([legacySession({ id: 'old1' })]));
  app.showSessionDetail('old1');
  ok(app._els['detail-content'].innerHTML.indexOf('detail-stars') !== -1, '星の入力欄が出ていない');
  await app.updateSessionStars('old1', 5);
  eq(app.getSessions()[0].stars, 5);
  // タイムや工程は触らない
  eq(app.getSessions()[0].totalTime, 6000);
  eq(app.getSessions()[0].steps.length, 2);
  await app.updateSessionStars('old1', 5);
  eq(app.getSessions()[0].stars, 0, '同じ星で取り消しにならない');
  // 存在しない id では何も壊さない
  await app.updateSessionStars('no-such-id', 3);
  eq(app.getSessions().length, 1);
});

test('分析の星フィルタは「以上」で絞り、未評価だけの抽出もできる', () => {
  const app = loadApp();
  const s0 = legacySession();          // 未評価
  const s3 = newSession({ stars: 3 });
  const s5 = newSession({ stars: 5 });
  // 空文字は絞り込みなし
  ok(app.matchStarFilter(s0, ''));
  ok(app.matchStarFilter(s5, ''));
  // '4' は 4以上
  ok(!app.matchStarFilter(s3, '4'));
  ok(app.matchStarFilter(s5, '4'));
  ok(app.matchStarFilter(s3, '3'));
  // '5' は 5のみ
  ok(!app.matchStarFilter(s3, '5'));
  ok(app.matchStarFilter(s5, '5'));
  // '0' は未評価のみ
  ok(app.matchStarFilter(s0, '0'));
  ok(!app.matchStarFilter(s3, '0'));
});

// ================================================================ 11. ヒートマップと累計カウンター（v1.7.0）

// 指定日からの相対日で ISO 文字列を作る（ローカル時刻の 10:00 に置く）
function daysAgoISO(n, hour) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour === undefined ? 10 : hour, 0, 0, 0);
  return d.toISOString();
}

function sessionOn(iso, seconds, over) {
  return Object.assign(newSession({ id: 'h' + iso + Math.random(), date: iso, totalTime: seconds }), over || {});
}

test('マスの濃さは 1時間・2時間半・5時間を境に変わる', () => {
  const app = loadApp();
  eq(app.heatLevel(0), 0);
  eq(app.heatLevel(59 * 60), 1);
  eq(app.heatLevel(60 * 60), 2);
  eq(app.heatLevel(149 * 60), 2);
  eq(app.heatLevel(150 * 60), 3);
  eq(app.heatLevel(299 * 60), 3);
  eq(app.heatLevel(300 * 60), 4);
  // 通し練習（6時間30分）は最も濃い
  eq(app.heatLevel(390 * 60), 4);
});

test('同じ日に2回やった分は1つのマスに足し合わされる', () => {
  const app = loadApp();
  const iso = daysAgoISO(3, 9);
  const iso2 = daysAgoISO(3, 15);
  const daily = app.buildDailyTotals([sessionOn(iso, 3600), sessionOn(iso2, 1800)]);
  const keys = Object.keys(daily);
  eq(keys.length, 1, '同じ日が2つのマスに割れている');
  eq(daily[keys[0]].count, 2);
  eq(daily[keys[0]].seconds, 5400);
});

test('日付はローカル時刻で切る（深夜でも UTC に引きずられない）', () => {
  const app = loadApp();
  const d = new Date(2026, 8, 6, 1, 30);   // 2026-09-06 01:30 ローカル
  eq(app.dateKey(d), '2026-09-06');
});

test('ヒートマップは日曜始まりで、最後のマスが今日になる', () => {
  const app = loadApp();
  const cells = app.buildHeatmapCells([], new Date());
  eq(cells[0].dow, 0, '先頭が日曜になっていない');
  // 今週は途中なので最後の列は欠ける（週の頭まで遡るぶん最大6日ふえる）
  ok(cells.length >= app.HEATMAP_DAYS, 'マスが6ヶ月ぶんに足りない');
  ok(cells.length <= app.HEATMAP_DAYS + 6, 'マスが多すぎる: ' + cells.length);
  ok(cells[cells.length - 1].isToday, '最後のマスが今日ではない');
  ok(cells.filter(c => c.isToday).length === 1, '今日のマスが1つではない');
});

test('6ヶ月より古い記録はマスに乗らないが、累計には入る', () => {
  const app = loadApp();
  const old = sessionOn(daysAgoISO(300), 3600);
  const recent = sessionOn(daysAgoISO(5), 7200);
  const cells = app.buildHeatmapCells([old, recent], new Date());
  const lit = cells.filter(c => c.count > 0);
  eq(lit.length, 1, '6ヶ月より古い記録がマスに出ている');
  eq(lit[0].seconds, 7200);
  const t = app.buildTotals([old, recent]);
  eq(t.sessions, 2, '古い記録が総セッション数から抜けている');
  eq(t.seconds, 10800);
});

test('累計は「練習した日数」をユニークな日で数え、途中終了も含める', () => {
  const app = loadApp();
  const t = app.buildTotals([
    sessionOn(daysAgoISO(1, 9), 3600),
    sessionOn(daysAgoISO(1, 14), 1800),
    sessionOn(daysAgoISO(2), 900, { completed: false })
  ]);
  eq(t.sessions, 3);
  eq(t.days, 2, '同じ日の2回が2日と数えられている');
  eq(t.seconds, 6300, '途中終了した回の時間が抜けている');
  // 記録が無ければすべて 0
  const zero = app.buildTotals([]);
  eq([zero.sessions, zero.days, zero.seconds], [0, 0, 0]);
});

test('マスの説明文は、練習した日と何もない日で書き分ける', () => {
  const app = loadApp();
  const cells = app.buildHeatmapCells([sessionOn(daysAgoISO(2), 5400)], new Date());
  const lit = cells.filter(c => c.count > 0)[0];
  const empty = cells.filter(c => c.count === 0)[0];
  ok(app.heatCellText(lit).indexOf('1回・1時間30分') !== -1, '実際: ' + app.heatCellText(lit));
  ok(app.heatCellText(empty).indexOf('練習なし') !== -1, '実際: ' + app.heatCellText(empty));
});

test('カウンターとヒートマップを描くと、マスと数字が入る', () => {
  const app = loadApp(seedWith([
    sessionOn(daysAgoISO(1), 23400),        // 6時間30分
    sessionOn(daysAgoISO(1, 16), 3600),     // 同じ日にもう1回
    sessionOn(daysAgoISO(10), 1800)
  ]));
  app.renderHeatmap();
  eq(app._els['total-sessions'].textContent, '3回');
  eq(app._els['total-days'].textContent, '2日');
  eq(app._els['total-hours'].textContent, '8時間');   // 390 + 60 + 30 分
  const cells = app._els['heatmap-grid'].children;
  ok(cells.length >= app.HEATMAP_DAYS, 'マスが足りない');
  eq(cells.filter(c => c.className.indexOf('lv') !== -1).length, 2, '色の付いたマスの数が合わない');
  eq(cells.filter(c => c.className.indexOf('today') !== -1).length, 1);
});

// ---------------------------------------------------------------- 実行結果

(async () => {
  for (const t of asyncTests) {
    currentTest = t.name;
    try { await t.fn(); passed++; }
    catch (e) { failures.push({ name: t.name, message: e && e.message ? e.message : String(e) }); }
  }
  const total = passed + failures.length;
  if (failures.length) {
    console.log('\n失敗 ' + failures.length + ' / ' + total + '\n');
    failures.forEach(f => console.log('  x ' + f.name + '\n    ' + f.message));
    process.exit(1);
  }
  console.log('全 ' + total + ' 件 成功');
})();

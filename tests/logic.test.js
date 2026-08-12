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
  'renderBackupNotice', 'dismissBackupNotice', 'renderHome'
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
    ', setTimerState: (s) => { timerState = s; } };\n';
  vm.runInContext(SCRIPT_BODY + tail, ctx, { filename: 'index.html<script>' });
  const app = ctx.__app;
  app._els = els;
  app._storage = ctx.localStorage;
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

// ---------------------------------------------------------------- 実行結果

const total = passed + failures.length;
if (failures.length) {
  console.log('\n失敗 ' + failures.length + ' / ' + total + '\n');
  failures.forEach(f => console.log('  x ' + f.name + '\n    ' + f.message));
  process.exit(1);
}
console.log('全 ' + total + ' 件 成功');

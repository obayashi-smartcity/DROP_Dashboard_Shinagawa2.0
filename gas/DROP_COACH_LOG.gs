/**
 * DROP Coach V2（チャット版）— 記録用 Google Apps Script（Web アプリ）  v6（2026/11/13）
 * ------------------------------------------------------------
 * V2.0 リポジトリの drop_coach_with_sample.html から直接呼ばれ、チャット 1 回分（1 セッション）を
 * Google スプレッドシートに 1 行追記する。分析（共起ネットワーク・ソフト分類・ジャーニー・属性別）にそのまま使える列にしている。
 * ★ V1 のログ用 GAS とは別のプロジェクトとして新しく作り、別にデプロイすること（V1 のシート coach_log_v3 には書かない）。
 *
 * ■ 呼び出し順
 *   1) フロント → V2 仕上げ用 GAS（DROP_COACH_GPT.gs v8）… AI を使ったときだけ
 *   2) フロント → 本 GAS（action:"log"）… コピーしたとき／「おわる」を押したとき／途中で画面を離れたとき
 *   ※ 同じセッションで文面を直して再コピーすると、同じ「セッションID」の行がもう 1 行増える（分析では最後の行を使う）
 *   ※ 途中で画面を離れたときは navigator.sendBeacon で送る（「終了」列が「途中離脱」）
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login", "name":"...", "password":"..." } → { ok:true, token, expires_in }
 *   { "action":"log", "token":"...", "session":{ …チャット記録（drop_chat_v2 形式。HTML の buildRecord() を参照）… } }
 *     → { ok:true, sheet:"記録したシート名", row:行番号 }
 *
 * ■ 記録する列（シートが空なら見出し行を自動作成）
 *   LOG_HEADER を参照。主な列：
 *   - 気分（1〜10）… ユーザージャーニー（時刻×気分）用
 *   - した／よかった／どこが／だれと／このあと … 選んだタグ（4 層：行動／最初の関心（感情）／コンテンツ要素・人・空間／愛着の関心・意向）
 *   - ノード（共起用）… 「層:タグ」を｜区切りで並べたもの。共起ネットワークのノード・エッジにそのまま使う
 *   - ソフト①②③・愛着 … 選んだタグから画面で計算した重み（合計 1。重みの表は HTML の CONFIG.VOCAB）
 *   - AI ソフト … AI が仕上げた文面から読んだサインの強さ（各 0〜1）
 *   - 表示順 … 選択肢をシャッフルして出した順（位置の偏りの検証用）
 *   - コーチ関与 … ひとことのみ／選択あり／AI 仕上げ（コーチが入った投稿を分けて効果測定するため）
 *
 * ■ スクリプトプロパティ
 *   必須  APP_PASSWORD（V2 仕上げ用 GAS と同じ値）
 *   任意  LOG_SHEET_ID（スプレッドシート ID。未設定ならこのスクリプトが紐づくスプレッドシート）
 *         LOG_SHEET_NAME (coach_chat_v2) / TOKEN_TTL_SEC (21600) / MAX_FAILS (30) / MAX_LOGS_PER_TOKEN (300)
 *
 * ■ 新規作成とデプロイ（V1 とは別プロジェクト）
 *   1) 記録先のスプレッドシートを用意（V1 と同じファイルでも可。シートは coach_chat_v2 が自動で作られる）
 *   2) https://script.google.com →「新しいプロジェクト」→ 名前を「DROP Coach V2 log」などにする → このファイルを貼り付けて保存
 *   3) スクリプト プロパティに APP_PASSWORD と LOG_SHEET_ID を追加
 *   4) setupTest() を 1 回実行（初回は権限を承認。シートの作成と書き込みを確認。テスト行は「テスト」と入る）
 *   5) デプロイ → 新しいデプロイ → 種類「ウェブアプリ」／実行「自分」／アクセス「全員」
 *   6) 表示された /exec の URL を drop_coach_with_sample.html の CONFIG.LOG_URL に貼る
 *   更新時：貼り替え → デプロイを管理 → 編集 → 新バージョン（URL は変わらない）
 *   LOG_URL?diag=1 をブラウザで開くと記録先の状態を確認できる
 */
const LOG_HEADER = [
  'タイムスタンプ', 'Name', 'セッションID', '終了', '開始', '所要秒', '回答数', '出した問い数', '最後の問い', '写真',
  '最初のひとこと', '気分', 'した', 'よかった', 'どこが', 'だれと', 'どんな人', 'このあと', '属性',
  'ハッシュタグ', 'ノード（共起用）', 'ソフト①挑戦', 'ソフト②属性横断', 'ソフト③心理的安全性', 'ソフト愛着',
  '組み立て文面', 'AI文面', '最終文面', '採用', '手で編集', 'コーチ関与',
  'AI状態', 'AI分類', 'AIソフト', 'AI 5W1H', 'AI評価', 'AIひとこと', '写真と本文', 'AI注意', 'AIモデル', 'プロンプト版', 'AI秒',
  '表示順', '問いごとの秒', 'アプリ版', '記録JSON'
];
const END_LABEL = { copy: 'コピー', finish: '完了', abandon: '途中離脱', reset: 'やり直し' };
const DEFAULTS = { LOG_SHEET_NAME: 'coach_chat_v2', TOKEN_TTL_SEC: 21600, MAX_FAILS: 30, MAX_LOGS_PER_TOKEN: 300 };
const CACHE_MAX_SEC = 21600;
const FAIL_WINDOW_SEC = 900;
const MAX_LEN = { NAME: 40, ID: 64, TEXT: 400, SHORT: 120, FIELD: 1000, ITEMS: 12, MSG: 300, META: 80, JSON_CELL: 45000 };
const KEY = { FAIL: 'chatlog_auth_fail', TOKEN: 'chatlogtok_' };
const SERVICE_VERSION = 6;

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== undefined && v !== '') return v;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? String(DEFAULTS[key]) : null;
}
function numProp_(key) {
  const n = Number(prop_(key));
  return isFinite(n) && n > 0 ? n : Number(DEFAULTS[key]);
}

/* ============================ エントリ ============================ */
function doPost(e) {
  try {
    let req;
    try {
      req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      throw new AppError('BAD_REQUEST', 'リクエストが JSON ではありません');
    }
    switch (req && req.action) {
      case 'login': return handleLogin_(req);
      case 'log':   return handleLog_(req);
      default:      throw new AppError('BAD_REQUEST', '不明な action です');
    }
  } catch (err) {
    if (err instanceof AppError) {
      (err.code === 'AUTH' ? console.warn : console.error)('[' + err.code + '] ' + err.message);
      return json_({ ok: false, code: err.code, message: err.message });
    }
    console.error((err && err.stack) || err);
    return json_({ ok: false, code: 'SERVER', message: 'ログ記録でサーバーエラーが発生しました' });
  }
}
/** ブラウザで LOG_URL を開くと疎通確認。?diag=1 で記録先の状態も返す */
function doGet(e) {
  const out = { ok: true, service: 'drop-coach-chat-log', version: SERVICE_VERSION, time: new Date().toISOString() };
  if (e && e.parameter && e.parameter.diag) {
    out.password_set = !!prop_('APP_PASSWORD');
    out.sheet_id_set = !!prop_('LOG_SHEET_ID');
    try { out.sheet = getSheet_().getName(); out.sheet_ok = true; }
    catch (err) { out.sheet_ok = false; out.sheet_error = String(err && err.message || err); }
  }
  return json_(out);
}

/* ============================ ログイン ============================ */
function handleLogin_(req) {
  const expected = prop_('APP_PASSWORD');
  if (!expected) throw new AppError('CONFIG', 'ログ記録用 GAS の APP_PASSWORD が未設定です');
  const name = clean_(req.name, MAX_LEN.NAME).replace(/\s+/g, ' ');
  if (!name) throw new AppError('BAD_REQUEST', 'Name を入力してください');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(KEY.FAIL) || 0);
  if (fails >= numProp_('MAX_FAILS')) {
    throw new AppError('LOCKED', 'パスワードの失敗回数が上限に達しました。15 分ほど待ってから再試行してください');
  }
  const pw = String(req.password || '');
  if (!pw || !safeEqual_(sha256_(pw), sha256_(expected))) {
    cache.put(KEY.FAIL, String(fails + 1), FAIL_WINDOW_SEC);
    Utilities.sleep(800);
    throw new AppError('AUTH', 'パスワードが違います');
  }
  cache.remove(KEY.FAIL);
  const ttl = Math.min(numProp_('TOKEN_TTL_SEC'), CACHE_MAX_SEC);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put(KEY.TOKEN + sha256_(token), JSON.stringify({ name: name, n: 0, exp: Date.now() + ttl * 1000 }), ttl);
  return json_({ ok: true, token: token, expires_in: ttl });
}

/* ============================== 記録 ============================== */
function handleLog_(req) {
  const cache = CacheService.getScriptCache();
  const key = KEY.TOKEN + sha256_(String(req.token || ''));
  let session = null;
  try { session = JSON.parse(cache.get(key) || 'null'); } catch (e) {}
  if (!req.token || !session || !session.name) {
    throw new AppError('AUTH', 'ログ記録の認証期限が切れました。再ログインしてください');
  }
  if (session.n >= numProp_('MAX_LOGS_PER_TOKEN')) {
    throw new AppError('BAD_REQUEST', 'このログインでの記録回数が上限に達しました。再ログインしてください');
  }
  const s = req.session && typeof req.session === 'object' ? req.session : null;
  if (!s) throw new AppError('BAD_REQUEST', 'session（チャット記録）がありません');

  const row = buildRow_(session.name, s);
  const written = appendRow_(row);

  session.n = (session.n || 0) + 1;
  const rest = Math.floor((session.exp - Date.now()) / 1000);
  if (rest > 1) cache.put(key, JSON.stringify(session), Math.min(rest, CACHE_MAX_SEC));
  return json_({ ok: true, sheet: written.sheet, row: written.row });
}

/** チャット記録 → 1 行。値はすべて検証・丸めてから書く */
function buildRow_(name, s) {
  const o = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const t = (v, n) => clean_(typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''), n || MAX_LEN.FIELD);
  const arr = v => (Array.isArray(v) ? v : []);
  const labels = v => arr(v).map(x => (typeof x === 'string' ? x : o(x).label)).filter(x => typeof x === 'string' && x.trim()).slice(0, MAX_LEN.ITEMS).map(x => t(x, MAX_LEN.SHORT));
  const num = (v, min, max) => { const n = Number(v); return v === '' || v == null || !isFinite(n) ? '' : Math.min(max, Math.max(min, n)); };
  const r2 = v => { const n = num(v, 0, 1); return n === '' ? '' : Math.round(n * 100) / 100; };
  const date = v => { const d = new Date(String(v || '')); return isNaN(d.getTime()) ? '' : d; };
  const yn = v => (v === true ? 'あり' : v === false ? 'なし' : '');

  const a = o(s.answers), soft = o(s.soft), ai = o(s.ai), ar = o(ai.result), as = o(ar.soft), texts = o(s.texts);
  const who = o(a.who);
  const sid = /^[A-Za-z0-9_-]{6,64}$/.test(String(s.session_id || '')) ? String(s.session_id) : '';
  const end = Object.prototype.hasOwnProperty.call(END_LABEL, s.end) ? END_LABEL[s.end] : t(s.end, 20);
  const aiState = ai.status === 'OK' ? (ai.cached ? 'OK（キャッシュ）' : 'OK') : t(ai.status, 20);
  const cat = o(ar.category);
  const nodes = arr(s.nodes).map(n => (typeof n === 'string' ? n : (o(n).layer && o(n).label ? o(n).layer + ':' + o(n).label : '')))
    .filter(Boolean).slice(0, 30).map(x => t(x, MAX_LEN.SHORT));
  const order = o(s.order);
  const orderText = Object.keys(order).slice(0, 12).map(k => t(k, 20) + '=' + arr(order[k]).slice(0, 20).map(x => t(String(x), 30)).join(',')).join(' / ');
  const secs = o(s.step_sec);
  const secText = Object.keys(secs).slice(0, 15).map(k => t(k, 20) + '=' + (num(secs[k], 0, 86400) === '' ? '' : Math.round(Number(secs[k]) * 10) / 10)).join(' / ');
  const softPct = x => (x === '' ? '' : x);

  let jsonCell = '';
  try { jsonCell = JSON.stringify(s); } catch (e) { jsonCell = ''; }
  if (jsonCell.length > MAX_LEN.JSON_CELL) jsonCell = '（サイズ超過のため省略）';

  return [
    new Date(),
    name,
    sid,
    end,
    date(s.started_at),
    num(s.duration_sec, 0, 86400) === '' ? '' : Math.round(Number(s.duration_sec) * 10) / 10,
    num(s.answered, 0, 99),
    num(s.asked, 0, 99),
    t(s.last_step, 30),
    s.has_photo === true ? 'あり' : 'なし',
    t(a.text1, MAX_LEN.TEXT),
    num(a.mood, 1, 10),
    labels(a.act).join('、'),
    labels(a.feel).join(' > '),
    labels(a.elem).join('、'),
    t(who.label, MAX_LEN.SHORT),
    t(who.detail, MAX_LEN.SHORT),
    labels(a.next).join('、'),
    t(o(a.profile).label || a.profile, MAX_LEN.SHORT),
    arr(s.hashtags).filter(x => typeof x === 'string').slice(0, 10).map(x => t(x, 40)).join(' '),
    nodes.join('｜'),
    softPct(r2(soft.c1)), softPct(r2(soft.c2)), softPct(r2(soft.c3)), softPct(r2(soft.att)),
    t(texts.composed, MAX_LEN.TEXT),
    t(texts.ai, MAX_LEN.TEXT),
    t(texts.final, MAX_LEN.TEXT),
    t(texts.chosen, 20),
    yn(texts.edited),
    t(s.coach_level, 20),
    aiState,
    cat.code ? t(cat.code, 2) + ' ' + t(cat.label, 30) : '',
    ai.status === 'OK' ? ['①' + r2(as.c1), '②' + r2(as.c2), '③' + r2(as.c3), '愛' + r2(as.att)].join(' ') : '',
    t(ar.w5h, MAX_LEN.SHORT),
    t(ar.level, 4),
    t(ar.headline, MAX_LEN.SHORT),
    ar.photo ? [t(o(ar.photo).match, 10), t(o(ar.photo).summary, MAX_LEN.SHORT)].filter(Boolean).join('：') : '',
    arr(ar.caveats).filter(x => typeof x === 'string').slice(0, 3).map(x => '・' + t(x, MAX_LEN.SHORT)).join('\n'),
    t(ai.model, MAX_LEN.META),
    t(ai.prompt_version, MAX_LEN.META),
    num(ai.elapsed_sec, 0, 600),
    t(orderText, MAX_LEN.FIELD),
    t(secText, MAX_LEN.FIELD),
    t(s.app_version, 40),
    jsonCell
  ];
}

/**
 * 1 行追記する
 *  - 見出しが一致しないシートに当たっても止めず、列構成専用の別シートへ自動で書く
 *  - 書き込み前に列数を確保し、「最終行の次」を明示して setValues で書く
 *  戻り値：{ sheet: シート名, row: 書き込んだ行番号 }
 */
function appendRow_(row) {
  // 先頭が = + - @ の文字列は数式として解釈されないよう ' を付ける
  const safe = v => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { throw new AppError('BUSY', 'ログ記録が混み合っています'); }
  try {
    const sh = getSheet_();
    const r = sh.getLastRow() + 1;
    ensureSize_(sh, r, LOG_HEADER.length);
    sh.getRange(r, 1, 1, LOG_HEADER.length).setValues([row.slice(0, LOG_HEADER.length).map(safe)]);
    SpreadsheetApp.flush();
    return { sheet: sh.getName(), row: r };
  } finally {
    lock.releaseLock();
  }
}
function openSpreadsheet_() {
  const id = String(prop_('LOG_SHEET_ID') || '').trim();
  let ss;
  try {
    ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    console.error('open spreadsheet failed', e);
    throw new AppError('CONFIG', 'スプレッドシートを開けません（LOG_SHEET_ID とデプロイしたアカウントの編集権限を確認してください）');
  }
  if (!ss) throw new AppError('CONFIG', 'LOG_SHEET_ID が未設定です（スプレッドシートに紐づかないプロジェクトでは必須）');
  return ss;
}
/** 見出しが LOG_HEADER と一致するシートを返す（無ければ作る）。不一致なら列構成ごとの別シートに切り替える */
function getSheet_() {
  const ss = openSpreadsheet_();
  const base = prop_('LOG_SHEET_NAME');
  const sh = ss.getSheetByName(base) || ss.insertSheet(base);
  if (prepareSheet_(sh)) return sh;
  const alt = base + '_' + sha256_(LOG_HEADER.join('\t')).slice(0, 6);
  console.warn('シート「' + base + '」の見出しが列構成と一致しないため「' + alt + '」に記録します');
  const sh2 = ss.getSheetByName(alt) || ss.insertSheet(alt);
  if (prepareSheet_(sh2)) return sh2;
  throw new AppError('CONFIG', 'シート「' + alt + '」の見出しが列構成と一致しません。LOG_SHEET_NAME を新しいシート名に変更してください');
}
/** 空なら見出しを作る。見出しが一致すれば true */
function prepareSheet_(sh) {
  if (sh.getLastRow() === 0) {
    ensureSize_(sh, 1, LOG_HEADER.length);
    sh.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
    sh.getRange('E:E').setNumberFormat('yyyy/mm/dd hh:mm:ss');
    sh.getRange(1, 1, sh.getMaxRows(), LOG_HEADER.length).setVerticalAlignment('top');
    return true;
  }
  if (sh.getMaxColumns() < LOG_HEADER.length) return false;
  const head = sh.getRange(1, 1, 1, LOG_HEADER.length).getDisplayValues()[0].map(v => String(v).trim());
  return head.join('\t') === LOG_HEADER.join('\t');
}
function ensureSize_(sh, rows, cols) {
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), Math.max(rows - sh.getMaxRows(), 100));
}

/* ============================== 共通 ============================== */
function clean_(v, max) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, max);
}
function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/* ============================ 動作確認用 ============================ */
/** 新しいシートの作成と書き込みを確認（エディタから 1 回実行）。テスト行の Name は「テスト」 */
function setupTest() {
  console.log('APP_PASSWORD: ' + (prop_('APP_PASSWORD') ? '設定済み' : '★未設定'));
  console.log('LOG_SHEET_ID: ' + (prop_('LOG_SHEET_ID') ? '設定済み' : '未設定（このスクリプトが紐づくスプレッドシートを使用）'));
  const w = appendRow_(buildRow_('テスト', {
    session_id: 'test_' + Date.now(), end: 'finish', started_at: new Date().toISOString(), duration_sec: 42,
    answered: 4, asked: 6, last_step: 'next', has_photo: false,
    answers: { text1: 'テスト投稿', mood: 7, act: [{ label: '見た・聴いた' }], feel: [{ label: 'かわいい' }],
      elem: [], who: { label: 'ひとりで', detail: '' }, next: [{ label: 'また来たい' }], profile: { label: '品川で働いている' } },
    hashtags: ['#かわいい'], nodes: ['行動:見た・聴いた', '感情:かわいい', '意向:また来たい'],
    soft: { c1: 0, c2: 0, c3: 0, att: 1 },
    texts: { composed: 'テスト投稿\nまた来たい！', ai: '', final: 'テスト投稿\nまた来たい！', chosen: '組み立て', edited: false },
    coach_level: '選択あり', ai: { status: '' }, order: { feel: ['kawaii', 'oishii'] }, step_sec: { text1: 5.2 }, app_version: 'test'
  }));
  console.log('書き込み OK: シート「' + w.sheet + '」 ' + w.row + ' 行目');
}

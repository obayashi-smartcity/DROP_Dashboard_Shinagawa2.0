/**
 * DROP Coach V2 フォルダ — 記録用 Google Apps Script（Web アプリ）  v7（2026/11/13・チャット画面 v3 用）
 * ------------------------------------------------------------
 * drop_coach_with_sample.html（チャット v3）から直接呼ばれ、チャット 1 回分（1 セッション）を
 * Google スプレッドシートに 1 行追記する。drop_coach_dashboard.html（分析画面）からは管理者だけが読み出せる。
 * ★ V1 のログ用 GAS とは別のプロジェクト（00_GAS/DROP_COACH2.0/DROP_COACH_LOG）
 *
 * ■ v7 の変更（チャット v3 に合わせた作り直し）
 *   - 列を v3 の問い（ひとこと → だれと → どこが → 気持ち → このあと）に合わせて整理（54 列）。既定のシート名は chat_v3
 *     ★ スクリプトプロパティ LOG_SHEET_NAME に "log" を入れている場合は "chat_v3" に変更すること（v6 の列のシートには書かない）
 *   - action:"export" を追加：管理者パスワード（ADMIN_PASSWORD）でログインしたときだけ、記録を JSON で返す（分析画面用）
 *     参加者に配るパスワード（APP_PASSWORD）では読み出せない
 *
 * ■ 呼び出し
 *   チャット：ひとことのあと投稿文ができたとき（完了）／コピーしたとき／「最初から」（やり直し）／途中で画面を閉じたとき（途中離脱・sendBeacon）
 *   ※ 1 セッションで複数行になることがある。分析では同じ「セッションID」の最後の行を使う（分析画面は自動でそうする）
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login", "name":"...", "password":"..." } → { ok:true, token, expires_in, admin }
 *   { "action":"log", "token":"...", "session":{ …チャット記録（drop_chat_v3 形式。HTML の buildRecord() を参照）… } } → { ok:true, sheet, row }
 *   { "action":"export", "token":"（管理者のトークン）", "limit":3000, "json":false } → { ok:true, sheet, header:[…], rows:[[…], …], total }
 *
 * ■ スクリプトプロパティ
 *   必須  APP_PASSWORD   … 参加者用パスワード（仕上げ用 GAS と同じ値）
 *         LOG_SHEET_ID   … 記録先スプレッドシートの ID（V2 の LOG_DROP_COACH）。★ V1 の ID を入れないこと
 *   分析画面を使うなら  ADMIN_PASSWORD … 管理者用パスワード（APP_PASSWORD とは別の値にする）
 *   任意  LOG_SHEET_NAME (chat_v3) / TOKEN_TTL_SEC (21600) / MAX_FAILS (30) / MAX_LOGS_PER_TOKEN (300) / EXPORT_MAX_ROWS (5000)
 *
 * ■ 更新のしかた
 *   貼り替え → スクリプトプロパティ（LOG_SHEET_NAME を chat_v3 に・ADMIN_PASSWORD を追加）→ setupTest() を 1 回実行
 *   → デプロイを管理 → 編集 → 新バージョン（URL は変わらない）。LOG_URL?diag=1 をブラウザで開くと記録先の状態を確認できる
 */
const LOG_HEADER = [
  'タイムスタンプ', 'Name', 'セッションID', '終了', '開始', '所要秒', '回答数', '最後の問い', '写真',
  '最初のひとこと', 'ひとことから読み取れたもの', '話題',
  'だれと', 'どんな人', 'どこが', 'どこがの選び方', '気持ち（選んだ順）', '気持ちの向き', 'このあと', '属性', '体験の点数',
  'ノード（共起用）', 'ソフト①挑戦', 'ソフト②属性横断', 'ソフト③心理的安全性', 'ソフト愛着',
  '組み立て文面', 'AI文面', '最終文面', '採用', '手で編集', 'コーチ関与', 'ハッシュタグ',
  'AI分類', 'AIソフト', 'AI感情の向き', 'AI行動', 'AIコンテンツ', 'AI空間', 'AI 5W1H', 'AI評価', 'AIひとこと', '写真と本文', 'AI注意',
  'ヒント状態', 'ほかの人の例を見た', '投稿イメージを開いた', '表示順', '問いごとの秒', 'AIモデル', 'プロンプト版', 'AI秒', 'アプリ版', '記録JSON'
];
const END_LABEL = { copy: 'コピー', finish: '完了', abandon: '途中離脱', reset: 'やり直し' };
const ACT_LABEL = { watch: '見た・聴いた', eat: '食べた・飲んだ', make: '作った・体験した', buy: '買った', talk: '話した', host: '出展・出演・お手伝い', stroll: 'ぶらぶら回った' };
const DEFAULTS = { LOG_SHEET_NAME: 'chat_v3', TOKEN_TTL_SEC: 21600, MAX_FAILS: 30, MAX_LOGS_PER_TOKEN: 300, EXPORT_MAX_ROWS: 5000 };
const CACHE_MAX_SEC = 21600;
const FAIL_WINDOW_SEC = 900;
const MAX_LEN = { NAME: 40, ID: 64, TEXT: 400, SHORT: 120, FIELD: 1000, ITEMS: 12, MSG: 300, META: 80, JSON_CELL: 45000 };
const KEY = { FAIL: 'chatlog_auth_fail', TOKEN: 'chatlogtok_' };
const SERVICE_VERSION = 7;

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
      case 'login':  return handleLogin_(req);
      case 'log':    return handleLog_(req);
      case 'export': return handleExport_(req);
      default:       throw new AppError('BAD_REQUEST', '不明な action です');
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
  const out = { ok: true, service: 'drop-coach-chat-log', version: SERVICE_VERSION, actions: ['login', 'log', 'export'], time: new Date().toISOString() };
  if (e && e.parameter && e.parameter.diag) {
    out.password_set = !!prop_('APP_PASSWORD');
    out.admin_password_set = !!prop_('ADMIN_PASSWORD');
    out.sheet_id_set = !!prop_('LOG_SHEET_ID');
    out.sheet_name = prop_('LOG_SHEET_NAME');
    try { out.sheet = getSheet_().getName(); out.sheet_ok = true; }
    catch (err) { out.sheet_ok = false; out.sheet_error = String(err && err.message || err); }
  }
  return json_(out);
}

/* ============================ ログイン ============================ */
/** 参加者用（APP_PASSWORD）と管理者用（ADMIN_PASSWORD）。管理者のトークンだけが export できる */
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
  const admin = prop_('ADMIN_PASSWORD');
  const isAdmin = !!admin && !!pw && safeEqual_(sha256_(pw), sha256_(admin));
  if (!pw || (!isAdmin && !safeEqual_(sha256_(pw), sha256_(expected)))) {
    cache.put(KEY.FAIL, String(fails + 1), FAIL_WINDOW_SEC);
    Utilities.sleep(800);
    throw new AppError('AUTH', 'パスワードが違います');
  }
  cache.remove(KEY.FAIL);
  const ttl = Math.min(numProp_('TOKEN_TTL_SEC'), CACHE_MAX_SEC);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put(KEY.TOKEN + sha256_(token), JSON.stringify({ name: name, n: 0, admin: isAdmin, exp: Date.now() + ttl * 1000 }), ttl);
  return json_({ ok: true, token: token, expires_in: ttl, admin: isAdmin });
}
function session_(token) {
  if (!token) return null;
  try { return JSON.parse(CacheService.getScriptCache().get(KEY.TOKEN + sha256_(String(token))) || 'null'); } catch (e) { return null; }
}

/* ============================== 記録 ============================== */
function handleLog_(req) {
  const cache = CacheService.getScriptCache();
  const key = KEY.TOKEN + sha256_(String(req.token || ''));
  const session = session_(req.token);
  if (!session || !session.name) throw new AppError('AUTH', 'ログ記録の認証期限が切れました。再ログインしてください');
  if (session.n >= numProp_('MAX_LOGS_PER_TOKEN')) throw new AppError('BAD_REQUEST', 'このログインでの記録回数が上限に達しました。再ログインしてください');
  const s = req.session && typeof req.session === 'object' ? req.session : null;
  if (!s) throw new AppError('BAD_REQUEST', 'session（チャット記録）がありません');
  const written = appendRow_(buildRow_(session.name, s));
  session.n = (session.n || 0) + 1;
  const rest = Math.floor((session.exp - Date.now()) / 1000);
  if (rest > 1) cache.put(key, JSON.stringify(session), Math.min(rest, CACHE_MAX_SEC));
  return json_({ ok: true, sheet: written.sheet, row: written.row });
}

/* ============================== 読み出し（分析画面用・管理者のみ） ============================== */
function handleExport_(req) {
  const session = session_(req.token);
  if (!session || !session.name) throw new AppError('AUTH', 'ログインの有効期限が切れました。再ログインしてください');
  if (!session.admin) throw new AppError('FORBIDDEN', '記録の読み出しには管理者パスワードでのログインが必要です');
  const sh = getSheet_();
  const last = sh.getLastRow();
  const maxRows = Math.min(Number(req.limit) > 0 ? Number(req.limit) : numProp_('EXPORT_MAX_ROWS'), numProp_('EXPORT_MAX_ROWS'));
  const withJson = req.json === true;
  const width = withJson ? LOG_HEADER.length : LOG_HEADER.length - 1;   // 既定では記録JSON（最後の列）を返さない（軽くするため）
  if (last < 2) return json_({ ok: true, sheet: sh.getName(), header: LOG_HEADER.slice(0, width), rows: [], total: 0 });
  const from = Math.max(2, last - maxRows + 1);
  const values = sh.getRange(from, 1, last - from + 1, width).getValues()
    .map(r => r.map(v => (v instanceof Date ? v.toISOString() : v)));
  return json_({ ok: true, sheet: sh.getName(), header: LOG_HEADER.slice(0, width), rows: values, total: last - 1, truncated: from > 2 });
}

/** チャット記録（drop_chat_v3）→ 1 行。値はすべて検証・丸めてから書く */
function buildRow_(name, s) {
  const o = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const t = (v, n) => clean_(typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''), n || MAX_LEN.FIELD);
  const arr = v => (Array.isArray(v) ? v : []);
  const labels = v => arr(v).map(x => (typeof x === 'string' ? x : o(x).label)).filter(x => typeof x === 'string' && x.trim()).slice(0, MAX_LEN.ITEMS).map(x => t(x, MAX_LEN.SHORT));
  const num = (v, min, max) => { const n = Number(v); return v === '' || v == null || !isFinite(n) ? '' : Math.min(max, Math.max(min, n)); };
  const r2 = (v, min, max) => { const n = num(v, min, max); return n === '' ? '' : Math.round(n * 100) / 100; };
  const date = v => { const d = new Date(String(v || '')); return isNaN(d.getTime()) ? '' : d; };
  const yn = v => (v === true ? 'あり' : v === false ? 'なし' : '');
  const strs = (v, n, m) => arr(v).filter(x => typeof x === 'string').slice(0, m || 10).map(x => t(x, n || 40));

  const a = o(s.answers), det = o(s.detected), soft = o(s.soft), ai = o(s.ai), ar = o(ai.result), as = o(ar.soft), texts = o(s.texts), hint = o(s.hint);
  const who = o(a.who);
  const sid = /^[A-Za-z0-9_-]{6,64}$/.test(String(s.session_id || '')) ? String(s.session_id) : '';
  const end = Object.prototype.hasOwnProperty.call(END_LABEL, s.end) ? END_LABEL[s.end] : t(s.end, 20);
  const aiState = ai.status === 'OK' ? (ai.cached ? 'OK（キャッシュ）' : 'OK') : t(ai.status, 20);
  const cat = o(ar.category);
  const detText = [arr(det.feels).length ? '気持ち:' + strs(det.feel_labels || det.feels, 20).join('・') : '', det.who ? 'だれと:' + t(det.who_label || det.who, 30) : '', det.next ? 'このあと' : '', det.subject ? '話題:' + t(det.subject, 20) : '']
    .filter(Boolean).join(' ／ ');
  const whySrc = [...new Set(arr(a.why).map(x => t(o(x).src, 10)).filter(Boolean))].join('・');
  const nodes = arr(s.nodes).map(n => (typeof n === 'string' ? n : '')).filter(Boolean).slice(0, 30).map(x => t(x, MAX_LEN.SHORT));
  const order = o(s.order);
  const orderText = Object.keys(order).slice(0, 12).map(k => t(k, 20) + '=' + arr(order[k]).slice(0, 20).map(x => t(String(x), 30)).join(',')).join(' / ');
  const secs = o(s.step_sec);
  const secText = Object.keys(secs).slice(0, 15).map(k => t(k, 20) + '=' + (num(secs[k], 0, 86400) === '' ? '' : Math.round(Number(secs[k]) * 10) / 10)).join(' / ');
  const views = arr(s.example_views).slice(0, 20).map(v => { const x = o(v); return t(x.step, 20) + '（' + (num(x.at_sec, 0, 86400) === '' ? '' : Math.round(Number(x.at_sec))) + '秒）'; });
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
    t(s.last_step, 40),
    s.has_photo === true ? 'あり' : 'なし',
    t(s.text1, MAX_LEN.TEXT),
    detText,
    t(s.subject, 30),
    t(who.label, MAX_LEN.SHORT),
    t(who.detail, MAX_LEN.SHORT),
    labels(a.why).join('、'),
    whySrc,
    labels(a.feel).join(' > '),
    r2(s.valence, -1, 1),
    labels(a.next).join('、'),
    t(o(a.profile).label, MAX_LEN.SHORT),
    num(a.score, 1, 10),
    nodes.join('｜'),
    r2(soft.c1, 0, 1), r2(soft.c2, 0, 1), r2(soft.c3, 0, 1), r2(soft.att, 0, 1),
    t(texts.composed, MAX_LEN.TEXT),
    t(texts.ai, MAX_LEN.TEXT),
    t(texts.final, MAX_LEN.TEXT),
    t(texts.chosen, 20),
    yn(texts.edited),
    t(s.coach_level, 20),
    strs(s.hashtags, 40).join(' '),
    cat.code ? t(cat.code, 2) + ' ' + t(cat.label, 30) : '',
    ai.status === 'OK' ? ['①' + r2(as.c1, 0, 1), '②' + r2(as.c2, 0, 1), '③' + r2(as.c3, 0, 1), '愛' + r2(as.att, 0, 1)].join(' ') : '',
    ai.status === 'OK' ? r2(ar.sentiment, -1, 1) : '',
    ai.status === 'OK' ? t(ACT_LABEL[ar.act] || '', 20) : '',
    strs(ar.content, 20, 3).join('、'),
    strs(ar.space, 20, 2).join('、'),
    t(ar.w5h, MAX_LEN.SHORT),
    t(ar.level, 4),
    t(ar.headline, MAX_LEN.SHORT),
    ar.photo ? [t(o(ar.photo).match, 10), t(o(ar.photo).summary, MAX_LEN.SHORT)].filter(Boolean).join('：') : '',
    arr(ar.caveats).filter(x => typeof x === 'string').slice(0, 3).map(x => '・' + t(x, MAX_LEN.SHORT)).join('\n'),
    hint.status ? t(hint.status, 20) + (num(hint.elapsed_sec, 0, 600) === '' ? '' : '（' + hint.elapsed_sec + '秒）') : '',
    views.length ? views.length + '回：' + views.join('、') : '',
    num(s.preview_opens, 0, 999),
    t(orderText, MAX_LEN.FIELD),
    t(secText, MAX_LEN.FIELD),
    t(ai.model, MAX_LEN.META),
    t(ai.prompt_version, MAX_LEN.META),
    num(ai.elapsed_sec, 0, 600),
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
/**
 * 空なら見出しを作る。見出しが一致すれば true
 * v6.1：見出し行だけでデータが無いシート（V1 の記録シートをコピーして 1 行目だけ残した場合など）は、
 *       V2 の見出しに書き換えて使う（データ行があるシートは書き換えない）
 */
function prepareSheet_(sh) {
  if (sh.getLastRow() === 0) { writeHeader_(sh); return true; }
  const width = sh.getMaxColumns();
  const head = sh.getRange(1, 1, 1, width).getDisplayValues()[0].map(v => String(v).trim());
  if (width >= LOG_HEADER.length && head.slice(0, LOG_HEADER.length).join('\t') === LOG_HEADER.join('\t')) return true;
  // v6.2：古い版の見出し（LOG_HEADER の先頭部分）だけのシートは、足りない見出しを右に書き足して使う
  let k = head.length; while (k > 0 && !head[k - 1]) k--;
  if (k > 0 && k < LOG_HEADER.length && head.slice(0, k).join('\t') === LOG_HEADER.slice(0, k).join('\t')) {
    console.warn('シート「' + sh.getName() + '」の見出しに ' + (LOG_HEADER.length - k) + ' 列を書き足します');
    ensureSize_(sh, 1, LOG_HEADER.length);
    sh.getRange(1, k + 1, 1, LOG_HEADER.length - k).setValues([LOG_HEADER.slice(k)]).setFontWeight('bold');
    return true;
  }
  if (sh.getLastRow() === 1) {
    console.warn('シート「' + sh.getName() + '」は見出し行だけなので、V2 の見出しに書き換えます');
    sh.getRange(1, 1, 1, sh.getMaxColumns()).clearContent();
    writeHeader_(sh);
    return true;
  }
  return false;
}
function writeHeader_(sh) {
  ensureSize_(sh, 1, LOG_HEADER.length);
  sh.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  sh.getRange('E:E').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  sh.getRange(1, 1, sh.getMaxRows(), LOG_HEADER.length).setVerticalAlignment('top');
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
/** 記録先の作成と書き込みを確認（エディタから 1 回実行）。テスト行の Name は「テスト」 */
function setupTest() {
  console.log('APP_PASSWORD: ' + (prop_('APP_PASSWORD') ? '設定済み' : '★未設定'));
  console.log('ADMIN_PASSWORD: ' + (prop_('ADMIN_PASSWORD') ? '設定済み' : '未設定（分析画面から読み出せません）'));
  console.log('LOG_SHEET_ID: ' + (prop_('LOG_SHEET_ID') ? '設定済み' : '未設定（このスクリプトが紐づくスプレッドシートを使用）'));
  console.log('LOG_SHEET_NAME: ' + prop_('LOG_SHEET_NAME'));
  const w = appendRow_(buildRow_('テスト', {
    schema: 'drop_chat_v3', session_id: 'test_' + Date.now(), end: 'finish', started_at: new Date().toISOString(), duration_sec: 42,
    answered: 4, last_step: '最後まで', has_photo: false, text1: 'コーヒーおいしかった',
    detected: { feels: ['oishii'], feel_labels: ['おいしい'], who: '', next: false, subject: 'コーヒー' }, subject: 'コーヒー',
    answers: { who: { label: 'ひとりで', detail: '' }, why: [{ label: '味・香り', src: '選択肢' }], feel: [{ label: 'おいしい' }],
      next: [{ label: 'また来たい' }], profile: { label: '品川で働いている' } },
    valence: 1, nodes: ['コンテンツ:コーヒー', '人:ひとりで', 'コンテンツ:味・香り', '感情:おいしい', '意向:また来たい'],
    soft: { c1: 0, c2: 0, c3: 0, att: 1 },
    texts: { composed: 'コーヒーおいしかった\nまた来たい！', ai: '', final: 'コーヒーおいしかった\nまた来たい！', chosen: '自分の言葉', edited: false },
    coach_level: '選択あり', ai: { status: '' }, hint: { status: '' }, order: {}, step_sec: { who: 2.1 }, app_version: 'test'
  }));
  console.log('書き込み OK: シート「' + w.sheet + '」 ' + w.row + ' 行目（テスト行は消して大丈夫です）');
}

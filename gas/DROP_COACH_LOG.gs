/**
 * DROP Coach V2 フォルダ — 記録用 Google Apps Script（Web アプリ）  v8（2026/11/13・チャット画面 v3.1 用）
 * ------------------------------------------------------------
 * drop_coach_chat.html（チャット）から直接呼ばれ、チャット 1 回分（1 セッション）を
 * Google スプレッドシートに 1 行追記する。drop_coach_dashboard.html（分析画面）からは管理者だけが読み出せる。
 * もう 1 つの役割：運営が分析画面の「チャットの設定」で保存した「選択肢と重み」を settings シートにためて、チャットに配る。
 * ★ V1 のログ用 GAS とは別のプロジェクト（00_GAS/DROP_COACH2.0/DROP_COACH_LOG）
 *
 * ■ v8 の変更（2026/11/13）
 *   - チャットの設定（選択肢の言葉・KPI の重み・気持ちの向き・「どこが」の候補・選んだ順の重み）を GAS で預かる
 *     action:"settings"（だれでも読める・チャットが起動時に読む）／"save_settings"・"settings_history"（管理者だけ）
 *     保存のたびに settings シートへ 1 行（保存日時・版・保存した人・メモ・設定JSON）。いちばん下の行がいまの設定
 *   - 記録の列を 15 足した（記録JSON の右）：どこがの気持ち／どこがの重み（例「商品 1 / ショッパー（袋） 0.75」）／設定版／
 *     任意の問い（最低限の問いのあと任意の問いに答えたか：答えた／投稿文へ）／この端末で何本目（その日にコピーした本数。もう 1 本つくりたくなる仕掛けの効果を見る）／
 *     今日の発見・その人のふだん（任意の問い）／チャットの評価（使いごこち 5 段階・任意）・運営へのコメント（コピー後に聞く。終了＝「感想」の行で届く）／
 *     AI 何を・誰の立場・なぜ・変化・次の一歩（0〜2）・分析に使える（何を・なぜが具体的、誰の立場あり、変化か次の一歩あり）
 *     v7 の chat_v3 シートは、次の記録のときに見出しが自動で書き足される
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
 *   { "action":"settings" } → { ok:true, version:"設定3", saved_at, saved_by, settings:{…}|null }（null ＝まだ保存がない → チャットは初期値）
 *   { "action":"save_settings", "token":"（管理者）", "settings":{…}, "note":"メモ", "base_version":"設定3" } → { ok:true, version:"設定4" }
 *     base_version がいまの版と違う（ほかの人が先に保存した）ときは CONFLICT。force:true で上書き
 *   { "action":"settings_history", "token":"（管理者）" } → { ok:true, items:[{ version, saved_at, saved_by, note, settings }, …]（新しい順・20 件） }
 *
 * ■ スクリプトプロパティ
 *   必須  APP_PASSWORD   … 参加者用パスワード（仕上げ用 GAS と同じ値）
 *         LOG_SHEET_ID   … 記録先スプレッドシートの ID（V2 の LOG_DROP_COACH）。★ V1 の ID を入れないこと
 *   分析画面を使うなら  ADMIN_PASSWORD … 管理者用パスワード（APP_PASSWORD とは別の値にする）
 *   任意  LOG_SHEET_NAME (chat_v3) / SETTINGS_SHEET_NAME (settings) / TOKEN_TTL_SEC (21600) / MAX_FAILS (30) / MAX_LOGS_PER_TOKEN (300) / EXPORT_MAX_ROWS (5000)
 *
 * ■ 更新のしかた
 *   貼り替え → スクリプトプロパティ（LOG_SHEET_NAME を chat_v3 に・ADMIN_PASSWORD を追加）→ setupTest() を 1 回実行（settings シートもできる）
 *   → デプロイを管理 → 編集 → 新バージョン（URL は変わらない）。LOG_URL?diag=1 をブラウザで開くと記録先の状態を確認できる
 */
const LOG_HEADER = [
  'タイムスタンプ', 'Name', 'セッションID', '終了', '開始', '所要秒', '回答数', '最後の問い', '写真',
  '最初のひとこと', 'ひとことから読み取れたもの', '話題',
  'だれと', 'どんな人', 'どこが', 'どこがの選び方', '気持ち（選んだ順）', '気持ちの向き', 'このあと', '属性', '体験の点数',
  'ノード（共起用）', 'ソフト①挑戦', 'ソフト②属性横断', 'ソフト③心理的安全性', 'ソフト愛着',
  '組み立て文面', 'AI文面', '最終文面', '採用', '手で編集', 'コーチ関与', 'ハッシュタグ',
  'AI分類', 'AIソフト', 'AI感情の向き', 'AI行動', 'AIコンテンツ', 'AI空間', 'AI 5W1H', 'AI評価', 'AIひとこと', '写真と本文', 'AI注意',
  'ヒント状態', 'ほかの人の例を見た', '投稿イメージを開いた', '表示順', '問いごとの秒', 'AIモデル', 'プロンプト版', 'AI秒', 'アプリ版', '記録JSON',
  // v8 で追加（記録JSON の右に足す。v7 のシートは見出しを自動で書き足す）
  'どこがの気持ち', 'どこがの重み', '設定版', '任意の問い', 'この端末で何本目',
  '今日の発見', 'その人のふだん', 'チャットの評価', '運営へのコメント',
  'AI 何を', 'AI 誰の立場', 'AI なぜ', 'AI 変化', 'AI 次の一歩', '分析に使える'
];
const END_LABEL = { copy: 'コピー', finish: '完了', abandon: '途中離脱', reset: 'やり直し', feedback: '感想' };
// 分析に使える投稿か：5 つの要素（AI の読み取り 0＝無い／1＝あいまい／2＝具体的）
const ELEMENTS = [['what', '何を'], ['who', '誰の立場'], ['why', 'なぜ'], ['change', '変化'], ['next', '次の一歩']];
/** 「分析に使える」：何を・なぜ が具体的（2）で、誰の立場が書けていて（1 以上）、変化か次の一歩のどちらかがある（1 以上） */
function analyzable_(e) { const v = k => Number(e[k]) || 0; return v('what') >= 2 && v('why') >= 2 && v('who') >= 1 && (v('change') >= 1 || v('next') >= 1); }
const ACT_LABEL = { watch: '見た・聴いた', eat: '食べた・飲んだ', make: '作った・体験した', buy: '買った', talk: '話した', host: '出展・出演・お手伝い', stroll: 'ぶらぶら回った' };
const DEFAULTS = { LOG_SHEET_NAME: 'chat_v3', SETTINGS_SHEET_NAME: 'settings', SETTINGS_CACHE_SEC: 300, TOKEN_TTL_SEC: 21600, MAX_FAILS: 30, MAX_LOGS_PER_TOKEN: 300, EXPORT_MAX_ROWS: 5000 };
const CACHE_MAX_SEC = 21600;
const FAIL_WINDOW_SEC = 900;
const MAX_LEN = { NAME: 40, ID: 64, TEXT: 400, SHORT: 120, FIELD: 1000, ITEMS: 12, MSG: 300, META: 80, JSON_CELL: 45000 };
const KEY = { FAIL: 'chatlog_auth_fail', TOKEN: 'chatlogtok_', SETTINGS: 'chatlog_settings_cur' };
const SERVICE_VERSION = 8;

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
      case 'settings':         return handleSettings_();
      case 'save_settings':    return handleSaveSettings_(req);
      case 'settings_history': return handleSettingsHistory_(req);
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
  const out = { ok: true, service: 'drop-coach-chat-log', version: SERVICE_VERSION, actions: ['login', 'log', 'export', 'settings', 'save_settings', 'settings_history'], time: new Date().toISOString() };
  if (e && e.parameter && e.parameter.diag) {
    out.password_set = !!prop_('APP_PASSWORD');
    out.admin_password_set = !!prop_('ADMIN_PASSWORD');
    out.sheet_id_set = !!prop_('LOG_SHEET_ID');
    out.sheet_name = prop_('LOG_SHEET_NAME');
    try { out.sheet = getSheet_().getName(); out.sheet_ok = true; out.settings_version = currentSettings_().version || '（初期値）'; }
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
  const ji = LOG_HEADER.indexOf('記録JSON');   // 既定では記録JSON の列を返さない（重いため）
  const header = withJson ? LOG_HEADER.slice() : LOG_HEADER.filter((_, i) => i !== ji);
  if (last < 2) return json_({ ok: true, sheet: sh.getName(), header: header, rows: [], total: 0 });
  const from = Math.max(2, last - maxRows + 1), n = last - from + 1;
  let values;
  if (withJson) values = sh.getRange(from, 1, n, LOG_HEADER.length).getValues();
  else {
    const a = sh.getRange(from, 1, n, ji).getValues();
    const rest = LOG_HEADER.length - ji - 1;
    const b = rest > 0 ? sh.getRange(from, ji + 2, n, rest).getValues() : a.map(() => []);
    values = a.map((r, i) => r.concat(b[i]));
  }
  values = values.map(r => r.map(v => (v instanceof Date ? v.toISOString() : v)));
  return json_({ ok: true, sheet: sh.getName(), header: header, rows: values, total: last - 1, truncated: from > 2 });
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
    o(ar.elements) && Object.keys(o(ar.elements)).length ? ELEMENTS.map(([k, l]) => l + num(o(ar.elements)[k], 0, 2)).join(' ') : t(ar.w5h, MAX_LEN.SHORT),   // v8：AI 5W1H の列には 5 つの要素の要約を入れる
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
    jsonCell,
    t(s.why_for, 30),
    arr(a.why).slice(0, MAX_LEN.ITEMS).map(x => { const y = o(x); const w = num(y.rank_w, 0, 1); return t(y.label, MAX_LEN.SHORT) + (w === '' ? '' : ' ' + Math.round(w * 100) / 100); }).filter(v => v.trim()).join(' / '),
    t(s.settings_version, 40),
    t(s.extra, 20),   // 最低限の問いのあと：答えた（もう1つ答えた）／投稿文へ（任意の問いはとばした）／空（その前に終わった）
    num(s.post_no, 0, 999),
    labels(a.find).join('、'),
    t(o(a.face).label, MAX_LEN.SHORT),
    num(s.chat_rating, 1, 5),
    t(s.chat_comment, 300),
    ...ELEMENTS.map(([k]) => (ai.status === 'OK' ? num(o(ar.elements)[k], 0, 2) : '')),
    ai.status === 'OK' && o(ar.elements).what != null ? (analyzable_(o(ar.elements)) ? 'はい' : 'いいえ') : ''
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
/* ======================= チャットの設定（選択肢と重み） ======================= */
const SETTINGS_HEADER = ['保存日時', '版', '保存した人', 'メモ', '設定JSON'];
function settingsSheet_() {
  const ss = openSpreadsheet_();
  const name = prop_('SETTINGS_SHEET_NAME');
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, SETTINGS_HEADER.length).setValues([SETTINGS_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function settingsRow_(r) {
  let settings = null;
  try { settings = JSON.parse(String(r[4] || 'null')); } catch (e) { settings = null; }
  return { version: String(r[1] || ''), saved_at: r[0] instanceof Date ? r[0].toISOString() : String(r[0] || ''), saved_by: String(r[2] || ''), note: String(r[3] || ''), settings: settings };
}
/** いまの設定（settings シートのいちばん下の行）。5 分キャッシュ。まだ保存がなければ settings:null */
function currentSettings_() {
  const cache = CacheService.getScriptCache();
  const c = cache.get(KEY.SETTINGS);
  if (c) { try { return JSON.parse(c); } catch (e) { /* 読み直す */ } }
  const sh = settingsSheet_(), last = sh.getLastRow();
  const out = last >= 2 ? settingsRow_(sh.getRange(last, 1, 1, SETTINGS_HEADER.length).getValues()[0]) : { version: '', saved_at: '', saved_by: '', note: '', settings: null };
  try { const j = JSON.stringify(out); if (j.length < 90000) cache.put(KEY.SETTINGS, j, numProp_('SETTINGS_CACHE_SEC')); } catch (e) { /* キャッシュなしで続ける */ }
  return out;
}
function handleSettings_() {
  const c = currentSettings_();
  return json_({ ok: true, version: c.version, saved_at: c.saved_at, saved_by: c.saved_by, settings: c.settings });
}
function adminSession_(token) {
  const session = session_(token);
  if (!session || !session.name) throw new AppError('AUTH', 'ログインの有効期限が切れました。再ログインしてください');
  if (!session.admin) throw new AppError('FORBIDDEN', 'チャットの設定を変えるには、管理者パスワードでのログインが必要です');
  return session;
}
function handleSaveSettings_(req) {
  const session = adminSession_(req.token);
  const settings = sanitizeSettings_(req.settings);
  const json = JSON.stringify(settings);
  if (json.length > MAX_LEN.JSON_CELL) throw new AppError('BAD_REQUEST', '設定が大きすぎます（選択肢を減らしてください）');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    CacheService.getScriptCache().remove(KEY.SETTINGS);
    const cur = currentSettings_();
    if (req.force !== true && String(req.base_version || '') !== String(cur.version || '')) {
      throw new AppError('CONFLICT', 'ほかの人が先に設定を保存しました（いまの版：' + (cur.version || '初期値') + '）。読みなおしてから、もう一度保存してください');
    }
    const sh = settingsSheet_(), row = sh.getLastRow() + 1, ver = '設定' + (row - 1), now = new Date();
    sh.getRange(row, 1, 1, SETTINGS_HEADER.length).setValues([[now, ver, session.name, clean_(req.note, 200), json]]);
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(KEY.SETTINGS);
    return json_({ ok: true, version: ver, saved_at: now.toISOString(), saved_by: session.name, settings: settings });
  } finally {
    lock.releaseLock();
  }
}
function handleSettingsHistory_(req) {
  adminSession_(req.token);
  const sh = settingsSheet_(), last = sh.getLastRow();
  if (last < 2) return json_({ ok: true, items: [] });
  const from = Math.max(2, last - 19);
  const items = sh.getRange(from, 1, last - from + 1, SETTINGS_HEADER.length).getValues().map(settingsRow_).reverse();
  return json_({ ok: true, items: items });
}
/** 設定の検証：形・文字数・数値の範囲をそろえる（画面の normSettings と同じ考え方） */
function sanitizeSettings_(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!s) throw new AppError('BAD_REQUEST', 'settings（設定）がありません');
  const n = (v, lo, hi, d) => { const x = Number(v); return isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x * 1000) / 1000)) : d; };
  const lab = v => clean_(v, 24).replace(/\s+/g, ' ');
  const id = (v, i, pre) => (/^[A-Za-z0-9_-]{1,24}$/.test(String(v || '')) ? String(v) : pre + i);
  const w = v => { const x = v && typeof v === 'object' ? v : {}; return { c1: n(x.c1, 0, 1, 0), c2: n(x.c2, 0, 1, 0), c3: n(x.c3, 0, 1, 0), att: n(x.att, 0, 1, 0) }; };
  const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
  const LAYERS = ['人', 'コンテンツ', '空間'];
  const tgt = t => { const x = t && typeof t === 'object' ? t : {}; return { label: lab(x.label), layer: LAYERS.indexOf(x.layer) >= 0 ? x.layer : 'コンテンツ', w: w(x.w), off: x.off === true }; };
  const uniq = (list, what) => {
    const seen = {};
    list.forEach(x => { if (!x.label) throw new AppError('BAD_REQUEST', what + 'に、表示名が空のものがあります'); if (seen[x.label]) throw new AppError('BAD_REQUEST', what + 'の「' + x.label + '」が 2 つあります'); seen[x.label] = 1; });
    return list;
  };
  const visible = (list, min, what) => { if (list.filter(x => !x.off).length < min) throw new AppError('BAD_REQUEST', what + 'は、表示するものを ' + min + ' つ以上にしてください'); return list; };
  const rk = (v, def) => { const a = arr(v, 6).map(x => n(x, 0, 1, 0)); return a.length ? a : def; };
  const r = s.rank && typeof s.rank === 'object' ? s.rank : {};
  const feel = visible(uniq(arr(s.feel, 20).map((x, i) => {
    const y = x && typeof x === 'object' ? x : {};
    return { id: id(y.id, i, 'uf'), label: lab(y.label), val: n(y.val, -1, 1, 0), w: w(y.w), off: y.off === true, q: clean_(y.q, 60),
      targets: uniq(arr(y.targets, 10).map(tgt).filter(t => t.label), '「' + lab(y.label) + '」のどこがの候補') };
  }), '気持ち'), 2, '気持ち');
  const simple = (v, max, pre, what, withW) => visible(uniq(arr(v, max).map((x, i) => {
    const y = x && typeof x === 'object' ? x : {};
    const o = { id: id(y.id, i, pre), label: lab(y.label), off: y.off === true };
    if (withW) o.w = w(y.w);
    return o;
  }), what), 2, what);
  return {
    schema: 'drop_coach_settings_v1',
    rank: { feel: rk(r.feel, [1, 0.6, 0.45, 0.35]), why: rk(r.why, [1, 0.75, 0.5, 0.25]), next: rk(r.next, [1, 0.8]), find: rk(r.find, [1, 0.8]) },
    why_q_default: clean_(s.why_q_default, 60) || 'とくに印象に残ったのは、どこですか？',
    feel: feel,
    why_default: visible(uniq(arr(s.why_default, 12).map(tgt), '「どこが」の共通の候補'), 2, '「どこが」の共通の候補'),
    who: simple(s.who, 15, 'uw', 'だれと', true),
    next: simple(s.next, 15, 'un', 'このあと', true),
    find: Array.isArray(s.find) ? simple(s.find, 12, 'ui', '今日の発見', true) : [],
    face: Array.isArray(s.face) ? simple(s.face, 12, 'ua', 'その人のふだん', true) : [],
    profile: simple(s.profile, 12, 'up', 'あなたについて', false)
  };
}

function setupTest() {
  console.log('APP_PASSWORD: ' + (prop_('APP_PASSWORD') ? '設定済み' : '★未設定'));
  console.log('ADMIN_PASSWORD: ' + (prop_('ADMIN_PASSWORD') ? '設定済み' : '未設定（分析画面から読み出せません）'));
  console.log('LOG_SHEET_ID: ' + (prop_('LOG_SHEET_ID') ? '設定済み' : '未設定（このスクリプトが紐づくスプレッドシートを使用）'));
  console.log('LOG_SHEET_NAME: ' + prop_('LOG_SHEET_NAME'));
  console.log('チャットの設定: ' + (currentSettings_().version || 'まだ保存なし（チャットは初期値を使う）') + '（シート「' + settingsSheet_().getName() + '」）');
  const w = appendRow_(buildRow_('テスト', {
    schema: 'drop_chat_v3', session_id: 'test_' + Date.now(), end: 'finish', started_at: new Date().toISOString(), duration_sec: 42,
    answered: 4, last_step: '最後まで', has_photo: false, text1: 'コーヒーおいしかった',
    detected: { feels: ['oishii'], feel_labels: ['おいしい'], who: '', next: false, subject: 'コーヒー' }, subject: 'コーヒー',
    why_for: 'おいしい', settings_version: '初期値',
    answers: { who: { label: 'ひとりで', detail: '' }, why: [{ label: '味', src: '選択肢', rank_w: 1 }, { label: '香り', src: '選択肢', rank_w: 0.75 }], feel: [{ label: 'おいしい' }],
      next: [{ label: 'また来たい' }], profile: { label: '品川で働いている' } },
    valence: 1, nodes: ['コンテンツ:コーヒー', '人:ひとりで', 'コンテンツ:味・香り', '感情:おいしい', '意向:また来たい'],
    soft: { c1: 0, c2: 0, c3: 0, att: 1 },
    texts: { composed: 'コーヒーおいしかった\nまた来たい！', ai: '', final: 'コーヒーおいしかった\nまた来たい！', chosen: '自分の言葉', edited: false },
    coach_level: '選択あり', ai: { status: '' }, hint: { status: '' }, order: {}, step_sec: { who: 2.1 }, app_version: 'test'
  }));
  console.log('書き込み OK: シート「' + w.sheet + '」 ' + w.row + ' 行目（テスト行は消して大丈夫です）');
}

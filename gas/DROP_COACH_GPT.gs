/**
 * DROP Coach V2（チャット版）— 投稿文の仕上げ用 Google Apps Script（Web アプリ）  v9.1（2026/11/13・チャット画面 v3.2 用）
 * ------------------------------------------------------------
 * V2.0 リポジトリ（DROP_Dashboard_Shinagawa2.0）の drop_coach_chat.html（チャット）から呼ばれる。
 * ★ V1（DROP_Dashboard_Shinagawa1.0）の GAS とは別のプロジェクトとして新しく作り、別にデプロイすること。
 *   プロンプトも V2 リポジトリの prompt/drop_coach_chat.md を読む（V1 の GAS・プロンプト・シートには一切影響しない）。
 *
 * ■ 役割
 *   チャットで集めた「最初のひとこと（T）」「選んだ答え」「画面で組み立てた文面」「写真」を受け取り、
 *   Azure OpenAI で 3〜5 行の投稿文に整え、分析用の判定（KPI 分類・ソフト分類・5W1H など）と一緒に JSON で返す。
 *   AI は 1 セッション 1 回だけ呼ばれる想定（回数は画面側で制御。日次の上限は DAILY_LIMIT）。
 *
 * ■ V1（v7.1）からの主な変更
 *   - variant は "chat" のみ（with_sample / no_sample・posted モード・PV/いいね・目的 goal は廃止）
 *   - プロンプトは 1 ファイル（PROMPT_URL_CHAT）。共通＋種類別の分割はやめた
 *   - 出力を軽くした（改善アクション・参考投稿の傾向・問いなどを廃止）→ 応答が速くなる
 *     result = { category:{code,label}, soft:{c1,c2,c3,att}, act, content[], space[], sentiment, elements:{what,who,why,change,next}, level, rewrite, headline, photo:{match,summary}, caveats }
 *   - soft（ソフト分類）を追加：①②③・街への愛着のサインの強さを 0〜1 で返す（2026/11/13 定例「ハード分類でなくソフト分類」）
 *   - 画像は利用者の写真（data URL）と、任意で見本投稿の写真（data URL）だけ。GAS から外部 URL の画像は取りに行かない
 *
 * ■ v9 の変更（2026/11/13・チャット画面 v3 用）
 *   - hint の出力を変更：subject（話題）・why_options（「どこが」の問いに出す写真からの候補）
 * ■ v9.1 の変更（2026/11/13）hint の出力を subject・why_options の 2 つだけに（act・photo_summary・covered は coach と重複していたので削除）。
 *   coach の w5h（文字列）を elements（何を・誰の立場・なぜ・変化・次の一歩 を 0〜2 で）に置きかえ（分析に使える投稿かを数で見るため）。
 *   プロンプトは drop_coach_hint.md v10・drop_coach_chat.md v10.1 を使う
 *   - coach の出力に分析用の act（行動）・content（コンテンツ）・space（空間）・sentiment（感情の向き -1〜1）を追加
 *   - プロンプトは prompt/drop_coach_chat.md・drop_coach_hint.md の v9 を使う（画面 v3・GAS v9・プロンプト v9 はそろえて更新すること）
 *   - subject が 12 字を超えるときは空にする（問いの言い方が不自然になるため。画面の読み取りに任せる）。投稿文から # タグを除いたあとの行頭の空白も除く
 *
 * ■ v8.1 の変更（2026/11/13）ヒント（action:"hint"）を追加
 *   - 画面は「ひとこと」を送った直後に、ユーザーを待たせず裏で 1 回だけ hint を呼ぶ
 *   - 写真とひとことから「なにを？」の候補（what）・近い行動（act）・写真の要約・この人だけに聞く問い（followup_q）を返す
 *   - プロンプトは prompt/drop_coach_hint.md（PROMPT_URL_CHAT と同じフォルダから自動で読む。別の場所なら PROMPT_URL_HINT）
 *   - AI の呼び出しは 1 セッション 2 回（hint 1 回＋投稿文 1 回）が基本。DAILY_LIMIT の既定値を 200 → 400 に変更
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login", "name":"...", "password":"..." } → { ok:true, token, expires_in }
 *   { "action":"coach", "token":"...", "variant":"chat",
 *     "context":{ "event":"culture-snack-2026", "sample_total":8 },
 *     "target":{ "text":"最初のひとこと", "source":"first|composed", "name":"表示名(任意)", "image_data":"data:image/jpeg;base64,..."(任意) },
 *     "answers":[{ "q":"そのとき、だれと一緒でしたか？", "a":"ひとりで" }, …],
 *     "working_text":"画面で組み立てた文面（ハッシュタグなし）",
 *     "references":[{ "text":"…", "name":"運営作成 ①-1 …", "image_data":"data:…"(任意) }],   … 任意
 *     "force":false }
 *     → { ok:true, cached, elapsed_ms, model, prompt_version, generated_at, images_used, images_note, result:{…} }
 *   { "action":"hint", "token":"...", "variant":"chat", "context":{…},
 *     "target":{ "text":"最初のひとこと", "image_data":"data:…"(任意) } }
 *     → { ok:true, cached, elapsed_ms, model, prompt_version, result:{ subject:"コーヒー", why_options:[…] } }
 *   エラー → { ok:false, code:"AUTH|LOCKED|LIMIT|BUSY|BAD_REQUEST|CONFIG|AI|SERVER", message:"..." }
 *
 * ■ スクリプトプロパティ
 *   必須  APP_PASSWORD        … 画面で入力するパスワード（V2 ログ用 GAS と同じ値にする）
 *         AZURE_API_KEY_LUNA  … Azure OpenAI の API キー（※リポジトリには絶対に書かない）
 *         PROMPT_URL_CHAT     … V2 リポジトリの prompt/drop_coach_chat.md の URL（同じフォルダの drop_coach_hint.md もヒント用に読む）
 *                               例 https://github.com/obayashi-smartcity/DROP_Dashboard_Shinagawa2.0/blob/main/prompt/drop_coach_chat.md
 *                               （github.com の blob URL は raw URL に自動変換。リポジトリが非公開なら raw の取得に失敗するので注意）
 *   任意（括弧内は既定値）
 *     REASONING_EFFORT (none) / MAX_OUTPUT_TOKENS (2000) / TOKEN_TTL_SEC (21600) / RESULT_CACHE_SEC (21600)
 *     PROMPT_CACHE_SEC (300) / DAILY_LIMIT (400) / MAX_FAILS (30) / MAX_REFS (10) / MAX_TEXT (300)
 *     PROMPT_URL_HINT（未設定なら PROMPT_URL_CHAT と同じフォルダの drop_coach_hint.md）/ HINT_MAX_OUTPUT_TOKENS (800)
 *     ENABLE_IMAGES (true) / MAX_IMAGES (9) / MAX_IMAGE_BYTES (1500000) / IMAGE_DETAIL (low)
 *
 * ■ 新規作成とデプロイ（V1 とは別プロジェクト）
 *   1) https://script.google.com →「新しいプロジェクト」→ 名前を「DROP Coach V2 chat」などにする
 *   2) このファイルの中身をすべて貼り付けて保存（貼り付け後「&g」+「t;」「&l」+「t;」で検索し 0 件であることを確認）
 *   3) プロジェクトの設定 → スクリプト プロパティ に上の「必須」3 つを追加
 *   4) エディタで checkSetup() を実行（初回は権限を承認）→ ログに「★」が無いことを確認 → testChat() で疎通確認
 *   5) デプロイ → 新しいデプロイ → 種類「ウェブアプリ」／次のユーザーとして実行「自分」／アクセスできるユーザー「全員」
 *   6) 表示された /exec の URL を drop_coach_chat.html の CONFIG.GAS_URL に貼る
 *   コードを更新したとき：貼り替え → デプロイを管理 → 編集 → バージョン「新バージョン」（URL は変わらない）
 *   プロンプトだけ直したとき：GitHub に push すれば PROMPT_CACHE_SEC（5 分）以内に反映。すぐ反映したいときは clearPromptCache() を実行
 */

/* ============================== 設定 ============================== */
const AZURE_MODEL = {
  name: 'gpt-6-luna',
  deployment: 'gpt-6-luna',
  endpoint: 'https://uhr65-mkgfgxtk-eastus2.openai.azure.com',
  api_version: '2025-04-01-preview',
  secret: 'AZURE_API_KEY_LUNA'
};
const SERVICE_VERSION = 9.1;
const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
const DEFAULTS = {
  REASONING_EFFORT: 'none',
  MAX_OUTPUT_TOKENS: 2000,
  TOKEN_TTL_SEC: 21600,
  RESULT_CACHE_SEC: 21600,
  PROMPT_CACHE_SEC: 300,
  DAILY_LIMIT: 400,
  HINT_MAX_OUTPUT_TOKENS: 800,
  MAX_FAILS: 30,
  MAX_REFS: 10,
  MAX_TEXT: 300,
  ENABLE_IMAGES: 'true',
  MAX_IMAGES: 9,
  MAX_IMAGE_BYTES: 1500000,
  IMAGE_DETAIL: 'low'
};
const CACHE_MAX_SEC = 21600;
const FAIL_WINDOW_SEC = 900;
const KEY = { FAIL: 'chat_auth_fail', PROMPT: 'chat_prompt_v9_', TOKEN: 'chat_tok_', RESULT: 'chat_res91_', HINT: 'chat_hint91_', QUOTA: 'chat_count_' };
const LIMITS = { ANSWERS: 10, Q: 100, A: 150, WORKING: 400, CAVEATS: 2, NAME: 40, CONTEXT: 60 };
const LEVELS = ['低', '中', '高'];
const MATCHES = ['一致', '一部一致', '不一致'];
/* コクヨ KPI（3 つのカルチャー変革）による判定。D は「当てはまらない」 */
const CATEGORIES = {
  A: { label: '①挑戦' },
  B: { label: '②属性横断' },
  C: { label: '③信頼・心理的安全性' },
  D: { label: '該当なし' }
};
const SOFT_KEYS = ['c1', 'c2', 'c3', 'att'];
/* ヒントの行動（画面の「なにをしていましたか？」の選択肢 id と同じ） */
const ACTS = ['watch', 'eat', 'make', 'buy', 'talk', 'host', 'stroll'];
const ELEMENT_KEYS = ['what', 'who', 'why', 'change', 'next'];   // 何を・誰の立場・なぜ・変化・次の一歩
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== undefined && v !== '') return v;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? String(DEFAULTS[key]) : null;
}
function numProp_(key) {
  const raw = prop_(key);
  const n = Number(raw);
  return raw === null || raw === '' || !isFinite(n) ? Number(DEFAULTS[key]) : n;
}
function boolProp_(key) { return String(prop_(key)).trim().toLowerCase() !== 'false'; }
function azureUrl_() {
  return AZURE_MODEL.endpoint.replace(/\/+$/, '') +
    '/openai/deployments/' + encodeURIComponent(AZURE_MODEL.deployment) +
    '/chat/completions?api-version=' + encodeURIComponent(AZURE_MODEL.api_version);
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
      case 'coach': return handleCoach_(req);
      case 'hint':  return handleHint_(req);
      default:      throw new AppError('BAD_REQUEST', '不明な action です');
    }
  } catch (err) {
    if (err instanceof AppError) return fail_(err.code, err.message);
    console.error((err && err.stack) || err);
    return fail_('SERVER', 'サーバーエラーが発生しました。管理者は GAS の実行ログを確認してください');
  }
}
/** ブラウザで GAS_URL を開くと疎通確認（version が 8 でなければ新しいバージョンが未デプロイ） */
function doGet() {
  return json_({ ok: true, service: 'drop-coach-chat', version: SERVICE_VERSION, variants: ['chat'], actions: ['login', 'coach', 'hint'], images: boolProp_('ENABLE_IMAGES'), time: new Date().toISOString() });
}

/* ============================ ログイン ============================ */
function handleLogin_(req) {
  const expected = prop_('APP_PASSWORD');
  if (!expected) throw new AppError('CONFIG', 'APP_PASSWORD が未設定です');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(KEY.FAIL) || 0);
  if (fails >= numProp_('MAX_FAILS')) {
    throw new AppError('LOCKED', 'パスワードの失敗回数が上限に達しました。15 分ほど待ってから再試行してください');
  }
  const pw = String((req && req.password) || '');
  if (!pw || !safeEqual_(sha256_(pw), sha256_(expected))) {
    cache.put(KEY.FAIL, String(fails + 1), FAIL_WINDOW_SEC);
    Utilities.sleep(800);
    throw new AppError('AUTH', 'パスワードが違います');
  }
  cache.remove(KEY.FAIL);
  const ttl = Math.min(numProp_('TOKEN_TTL_SEC'), CACHE_MAX_SEC);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put(KEY.TOKEN + sha256_(token), '1', ttl);
  return json_({ ok: true, token: token, expires_in: ttl });
}
function checkToken_(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get(KEY.TOKEN + sha256_(String(token))) === '1';
}

/* ============================== 仕上げ ============================== */
function handleCoach_(req) {
  const t0 = Date.now();
  if (!checkToken_(req.token)) {
    throw new AppError('AUTH', 'ログインの有効期限が切れました。パスワードを再入力してください');
  }
  const apiKey = prop_(AZURE_MODEL.secret);
  if (!apiKey) throw new AppError('CONFIG', 'スクリプトプロパティ ' + AZURE_MODEL.secret + ' が未設定です');
  if (req.variant && req.variant !== 'chat') throw new AppError('BAD_REQUEST', 'この GAS は variant "chat"（V2 チャット版）専用です');

  const target = sanitizeTarget_(req.target);
  if (!target) throw new AppError('BAD_REQUEST', 'ひとこと（または組み立てた文面）が空です');
  const uploadRejected = target._rejected;
  delete target._rejected;
  const references = sanitizeRefs_(req.references);
  const answers = sanitizeAnswers_(req.answers);
  const working = sanitizeText_(req.working_text, LIMITS.WORKING);
  const context = sanitizeContext_(req.context);

  const images = pickImages_([target].concat(references));
  const prompt = loadPrompt_('chat');
  const model = AZURE_MODEL.name;

  const cache = CacheService.getScriptCache();
  const cacheKey = KEY.RESULT + sha256_(JSON.stringify([
    model, prompt.version, context, target, references, answers, working,
    images.map(x => [x.id, sha256_(x.dataUrl).slice(0, 16)]), prop_('IMAGE_DETAIL')
  ]));
  if (!req.force) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const saved = JSON.parse(hit);
      saved.cached = true;
      saved.elapsed_ms = Date.now() - t0;
      return json_(saved);
    }
  }
  if (!adjustDailyQuota_(+1)) throw new AppError('LIMIT', '本日の AI 仕上げ回数の上限に達しました');

  const notes = [];
  if (uploadRejected) notes.push('写真を読み取れなかったため、文面のみで仕上げました');
  const vars = {
    CONTEXT: JSON.stringify(context),
    TARGET: JSON.stringify(target),
    ANSWERS: answers.length ? answers.map((x, i) => 'Q' + (i + 1) + ': ' + x.q + '\nA' + (i + 1) + ': ' + x.a).join('\n') : '（なし：選択肢には答えていない）',
    WORKING: working || '（なし）',
    REFERENCES: references.length ? JSON.stringify(references) : '（なし：SYSTEM の見本投稿を参考にする）',
    IMAGE_IDS: images.length ? images.map(x => x.id).join(', ') : '（なし）'
  };
  const userText = fillTemplate_(prompt.user, vars);
  const noImageNote = '\n\n※今回は画像が添付されていません。photo は match・summary とも空文字で返してください。';
  const textOnly = [{ role: 'system', content: prompt.system }, { role: 'user', content: userText + noImageNote }];
  const withImages = images.length ? [{ role: 'system', content: prompt.system }, { role: 'user', content: buildUserContent_(userText, images) }] : null;

  let data, imagesUsed = images.length;
  try {
    if (withImages) {
      try {
        data = callAzureOpenAI_(apiKey, withImages, OUTPUT_SCHEMA, 'drop_coach_chat', numProp_('MAX_OUTPUT_TOKENS'));
      } catch (err) {
        if (err instanceof AppError && err.code === 'AI' && /image|vision|content.*type|HTTP 400/i.test(err.message)) {
          console.warn('画像付きリクエストが拒否されたためテキストのみで再送します: ' + err.message);
          notes.push('AI が画像を受け付けなかったため、文面のみで仕上げました');
          imagesUsed = 0;
          data = callAzureOpenAI_(apiKey, textOnly, OUTPUT_SCHEMA, 'drop_coach_chat', numProp_('MAX_OUTPUT_TOKENS'));
        } else {
          throw err;
        }
      }
    } else {
      data = callAzureOpenAI_(apiKey, textOnly, OUTPUT_SCHEMA, 'drop_coach_chat', numProp_('MAX_OUTPUT_TOKENS'));
    }
  } catch (err) {
    adjustDailyQuota_(-1);
    throw err;
  }

  const payload = {
    ok: true,
    cached: false,
    variant: 'chat',
    model: model,
    prompt_version: prompt.version,
    generated_at: new Date().toISOString(),
    images_used: imagesUsed,
    images_note: notes.join(' / '),
    result: normalizeResult_(data, imagesUsed > 0 && images.some(x => x.id === 'T'))
  };
  try {
    cache.put(cacheKey, JSON.stringify(payload), Math.min(numProp_('RESULT_CACHE_SEC'), CACHE_MAX_SEC));
  } catch (e) { /* 100KB 超などは無視 */ }
  payload.elapsed_ms = Date.now() - t0;
  return json_(payload);
}

/* ============================== ヒント（v8.1） ============================== */
/**
 * 写真とひとことから、チャットの問いを手伝う材料を作る。画面はユーザーを待たせずに裏で呼ぶ（失敗しても画面は止まらない）
 * result（v9.1）= { subject（話題）, why_options（「どこが」の問いに「写真から」として出す候補 最大 3） }
 */
function handleHint_(req) {
  const t0 = Date.now();
  if (!checkToken_(req.token)) throw new AppError('AUTH', 'ログインの有効期限が切れました。パスワードを再入力してください');
  const apiKey = prop_(AZURE_MODEL.secret);
  if (!apiKey) throw new AppError('CONFIG', 'スクリプトプロパティ ' + AZURE_MODEL.secret + ' が未設定です');
  const target = sanitizeTarget_(req.target);
  if (!target) throw new AppError('BAD_REQUEST', 'ひとことが空です');
  delete target._rejected;
  delete target.source;
  const context = sanitizeContext_(req.context);
  const images = pickImages_([target]);
  const prompt = loadPrompt_('hint');
  const cache = CacheService.getScriptCache();
  const cacheKey = KEY.HINT + sha256_(JSON.stringify([AZURE_MODEL.name, prompt.version, context, target, images.map(x => sha256_(x.dataUrl).slice(0, 16)), prop_('IMAGE_DETAIL')]));
  const hit = cache.get(cacheKey);
  if (hit) { const saved = JSON.parse(hit); saved.cached = true; saved.elapsed_ms = Date.now() - t0; return json_(saved); }
  if (!adjustDailyQuota_(+1)) throw new AppError('LIMIT', '本日の AI 回数の上限に達しました');
  const userText = fillTemplate_(prompt.user, {
    CONTEXT: JSON.stringify(context), TARGET: JSON.stringify(target),
    IMAGE_IDS: images.length ? images.map(x => x.id).join(', ') : '（なし：写真はありません）'
  });
  const maxTok = numProp_('HINT_MAX_OUTPUT_TOKENS');
  let data, imagesUsed = images.length;
  try {
    if (images.length) {
      try {
        data = callAzureOpenAI_(apiKey, [{ role: 'system', content: prompt.system }, { role: 'user', content: buildUserContent_(userText, images) }], HINT_SCHEMA, 'drop_coach_hint', maxTok);
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'AI' && /image|vision|content.*type|HTTP 400/i.test(err.message))) throw err;
        imagesUsed = 0;
        data = callAzureOpenAI_(apiKey, [{ role: 'system', content: prompt.system }, { role: 'user', content: userText }], HINT_SCHEMA, 'drop_coach_hint', maxTok);
      }
    } else {
      data = callAzureOpenAI_(apiKey, [{ role: 'system', content: prompt.system }, { role: 'user', content: userText }], HINT_SCHEMA, 'drop_coach_hint', maxTok);
    }
  } catch (err) {
    adjustDailyQuota_(-1);
    throw err;
  }
  const payload = { ok: true, cached: false, model: AZURE_MODEL.name, prompt_version: prompt.version, generated_at: new Date().toISOString(),
    images_used: imagesUsed, result: normalizeHint_(data, imagesUsed > 0) };
  try { cache.put(cacheKey, JSON.stringify(payload), Math.min(numProp_('RESULT_CACHE_SEC'), CACHE_MAX_SEC)); } catch (e) { /* 無視 */ }
  payload.elapsed_ms = Date.now() - t0;
  return json_(payload);
}
function normalizeHint_(data) {
  const d = data && typeof data === 'object' ? data : {};
  const one = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const clean = v => v.replace(/[#＃「」『』。、！!？?]/g, '').trim();
  const why = Array.isArray(d.why_options) ? [...new Set(d.why_options.map(x => clean(one(x, 12))).filter(Boolean))].slice(0, 3) : [];
  return {
    subject: (s => (s.length > 12 ? '' : s))(clean(one(d.subject, 40))),   // 長すぎる話題は問いの言い方が不自然になるので使わない（画面の読み取りに任せる）
    why_options: why
  };
}

/* ---------- 入力整形 ---------- */
const str_ = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/** T：最初のひとこと（無ければ画面が組み立てた文面）。改行は残す。画像は data URL のみ */
function sanitizeTarget_(p) {
  if (!p || typeof p !== 'object') return null;
  const text = sanitizeText_(p.text, numProp_('MAX_TEXT'));
  if (!text) return null;
  const o = { id: 'T', source: p.source === 'composed' ? 'composed' : 'first', text_len: text.replace(/\s/g, '').length, text: text };
  if (p.name) o.name = str_(p.name, LIMITS.NAME);
  if (p.image_data) {
    const data = sanitizeImageData_(p.image_data);
    if (data) o.image_data = data; else o._rejected = true;
  }
  return o;
}
/** 見本投稿（任意）。本文・表示名・画像データ（任意）だけ */
function sanitizeRefs_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(p => p && typeof p === 'object')
    .slice(0, numProp_('MAX_REFS'))
    .map((p, i) => {
      const o = { id: 'R' + (i + 1), text: sanitizeText_(p.text, numProp_('MAX_TEXT')) };
      if (p.name) o.name = str_(p.name, LIMITS.NAME);
      const data = p.image_data ? sanitizeImageData_(p.image_data) : '';
      if (data) o.image_data = data;
      return o;
    })
    .filter(o => o.text);
}
/** チャットで選んだ答え。最大 10 件・問い 100 字・答え 150 字 */
function sanitizeAnswers_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(x => x && typeof x === 'object')
    .slice(0, LIMITS.ANSWERS)
    .map(x => ({ q: str_(x.q, LIMITS.Q), a: str_(x.a, LIMITS.A) }))
    .filter(x => x.q && x.a);
}
function sanitizeContext_(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const o = { app: 'DROP.Coach V2（チャット版）' };
  if (c.event) o.event = str_(c.event, LIMITS.CONTEXT);
  if (c.sample_total !== undefined && isFinite(Number(c.sample_total))) o.sample_total = Number(c.sample_total);
  return o;
}
function sanitizeText_(raw, max) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/^[ \t]*#+(?=\s)/gm, '')      // 行頭の Markdown 見出し記号だけ除く（#ハッシュタグは残す）
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/* ---------- 画像 ---------- */
/** 先頭バイトから画像形式を判定 */
function sniffType_(b) {
  const u = i => (b[i] === undefined ? -1 : b[i] & 0xff);
  if (u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF) return 'image/jpeg';
  if (u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) return 'image/png';
  if (u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 && u(8) === 0x57 && u(9) === 0x45) return 'image/webp';
  return '';
}
/** ブラウザから届いた data URL を検証。形式・サイズ・先頭バイトが正しいものだけ返す */
function sanitizeImageData_(v) {
  const s = String(v == null ? '' : v);
  const maxBytes = numProp_('MAX_IMAGE_BYTES');
  if (!s || s.length > Math.ceil(maxBytes * 4 / 3) + 40) return '';
  const m = s.match(DATA_URL_RE);
  if (!m) return '';
  let bytes;
  try { bytes = Utilities.base64Decode(m[2]); } catch (e) { return ''; }
  if (!bytes.length || bytes.length > maxBytes) return '';
  const type = sniffType_(bytes);
  if (!type) return '';
  return type === m[1] ? s : 'data:' + type + ';base64,' + m[2];
}
/** 投稿から画像を取り出し、上限枚数まで選ぶ（T 優先 → R の上から）。投稿オブジェクトからは削除 */
function pickImages_(posts) {
  const enabled = boolProp_('ENABLE_IMAGES');
  const max = Math.max(0, numProp_('MAX_IMAGES'));
  const out = [];
  posts.forEach(p => {
    const data = p.image_data;
    delete p.image_data;
    if (enabled && data && out.length < max) out.push({ id: p.id, dataUrl: data });
  });
  return out;
}
/** テキスト＋画像のマルチモーダル content を組み立てる（各画像の直前に ID ラベルを置く） */
function buildUserContent_(userText, images) {
  const detail = ['low', 'high', 'auto'].indexOf(String(prop_('IMAGE_DETAIL'))) >= 0 ? String(prop_('IMAGE_DETAIL')) : 'low';
  const parts = [{ type: 'text', text: userText }];
  images.forEach(img => {
    parts.push({ type: 'text', text: '【' + img.id + ' の画像】' });
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: detail } });
  });
  return parts;
}

/* ---------- 出力 ---------- */
/** AI 出力を画面が想定する形に整える */
function normalizeResult_(data, hasTargetImage) {
  const d = data && typeof data === 'object' ? data : {};
  const text = v => (typeof v === 'string' ? v.trim() : '');
  const list = (v, max) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, max) : []);
  const obj = v => (v && typeof v === 'object' ? v : {});
  const sf = obj(d.soft), ph = obj(d.photo);
  const soft = {};
  SOFT_KEYS.forEach(k => {
    const n = Number(sf[k]);
    soft[k] = isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 100) / 100 : 0;
  });
  const cat = Object.prototype.hasOwnProperty.call(CATEGORIES, d.category) ? d.category : '';
  const nouns = (v, max) => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string').map(x => x.replace(/\s+/g, ' ').trim().slice(0, 12)).filter(Boolean))].slice(0, max) : []);
  const sent = Number(d.sentiment);
  return {
    category: { code: cat, label: cat ? CATEGORIES[cat].label : '' },
    soft: soft,
    act: ACTS.indexOf(d.act) >= 0 ? d.act : '',
    content: nouns(d.content, 3),
    space: nouns(d.space, 2),
    sentiment: isFinite(sent) ? Math.round(Math.min(1, Math.max(-1, sent)) * 100) / 100 : 0,
    level: LEVELS.indexOf(d.level) >= 0 ? d.level : '',
    elements: ELEMENT_KEYS.reduce((o, k) => { const v = Number(d.elements && d.elements[k]); o[k] = v === 1 || v === 2 ? v : 0; return o; }, {}),
    // ハッシュタグは画面が付けるので、AI が付けてしまった行末のタグは外す
    rewrite: text(d.rewrite).replace(/[ \t　]*[#＃][^\s#＃]+/g, '').replace(/^[ \t　]+|[ \t　]+$/gm, '').replace(/\n{2,}/g, '\n').trim(),
    headline: text(d.headline),
    photo: hasTargetImage
      ? { match: MATCHES.indexOf(ph.match) >= 0 ? ph.match : '', summary: text(ph.summary) }
      : { match: '', summary: '' },
    caveats: list(d.caveats, LIMITS.CAVEATS)
  };
}

/* ============================ プロンプト ============================ */
/** kind：'chat'（投稿文）／'hint'（ヒント）。hint は PROMPT_URL_HINT、未設定なら PROMPT_URL_CHAT と同じフォルダの drop_coach_hint.md */
function loadPrompt_(kind) {
  kind = kind === 'hint' ? 'hint' : 'chat';
  const cache = CacheService.getScriptCache();
  const hit = cache.get(KEY.PROMPT + kind);
  if (hit) return JSON.parse(hit);
  const chatUrl = normalizePromptUrl_(prop_('PROMPT_URL_CHAT'));
  const url = kind === 'chat' ? chatUrl
    : (prop_('PROMPT_URL_HINT') ? normalizePromptUrl_(prop_('PROMPT_URL_HINT')) : chatUrl.replace(/[^/]*$/, 'drop_coach_hint.md'));
  const prompt = parsePrompt_(fetchPromptText_(url));
  cache.put(KEY.PROMPT + kind, JSON.stringify(prompt), Math.min(numProp_('PROMPT_CACHE_SEC'), CACHE_MAX_SEC));
  return prompt;
}
function fetchPromptText_(url) {
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    console.error('prompt fetch failed: ' + url, e);
    throw new AppError('CONFIG', 'プロンプトファイルに接続できません（' + url + '）。管理者は PROMPT_URL_CHAT を確認してください');
  }
  const code = res.getResponseCode();
  if (code !== 200) {
    console.error('prompt fetch HTTP ' + code + ': ' + url);
    throw new AppError('CONFIG', 'プロンプトファイルを取得できません（HTTP ' + code + '：' + url.replace(/^.*\//, '') + '）。GitHub に push 済みか、PROMPT_URL_CHAT を確認してください');
  }
  return res.getContentText('UTF-8');
}
function normalizePromptUrl_(url) {
  const u = String(url || '').trim();
  if (!u) throw new AppError('CONFIG', 'スクリプトプロパティ PROMPT_URL_CHAT が未設定です');
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? [RAW_GITHUB_BASE, m[1], m[2], m[3]].join('/') : u;
}
function parsePrompt_(rawText) {
  if (/^\s*<(!doctype|html)/i.test(rawText)) {
    throw new AppError('CONFIG', 'プロンプトが HTML で返りました。PROMPT_URL_CHAT に raw URL（または github.com の blob URL）を指定してください');
  }
  const text = rawText.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const m = text.match(/^#{2,3}[ \t]*SYSTEM[ \t]*\n([\s\S]*?)^#{2,3}[ \t]*USER[ \t]*\n([\s\S]*)$/im);
  if (!m) throw new AppError('CONFIG', 'プロンプトファイルに「### SYSTEM」「### USER」の見出しがありません');
  return { system: m[1].trim(), user: m[2].trim(), version: sha256_(text).slice(0, 10) };
}
function fillTemplate_(tpl, vars) {
  return tpl.replace(/\{\{\s*([\w\\]+?)\s*\}\}/g, (all, k) => {
    const name = k.replace(/\\/g, '');
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all;
  });
}
function clearPromptCache() {
  CacheService.getScriptCache().removeAll([KEY.PROMPT + 'chat', KEY.PROMPT + 'hint']);
  console.log('プロンプトのキャッシュを削除しました');
}

/* ============================== Azure OpenAI ============================== */
const OUTPUT_SCHEMA = (() => {
  const str = { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    // 出力順＝考える順（文面を整えてから、その文面で判定する）
    required: ['rewrite', 'category', 'soft', 'act', 'content', 'space', 'sentiment', 'elements', 'level', 'photo', 'headline', 'caveats'],
    properties: {
      rewrite: str,
      category: { type: 'string', enum: Object.keys(CATEGORIES) },
      act: { type: 'string', enum: ACTS.concat(['']) },
      content: { type: 'array', items: str },
      space: { type: 'array', items: str },
      sentiment: { type: 'number' },
      soft: {
        type: 'object', additionalProperties: false,
        required: SOFT_KEYS,
        properties: { c1: { type: 'number' }, c2: { type: 'number' }, c3: { type: 'number' }, att: { type: 'number' } }
      },
      // 分析に使える投稿か：5 つの要素がどこまで具体的に書けているか（0＝無い／1＝あいまい／2＝具体的）
      elements: {
        type: 'object', additionalProperties: false,
        required: ELEMENT_KEYS,
        properties: ELEMENT_KEYS.reduce((o, k) => { o[k] = { type: 'integer', enum: [0, 1, 2] }; return o; }, {})
      },
      level: { type: 'string', enum: LEVELS },
      photo: {
        type: 'object', additionalProperties: false,
        required: ['match', 'summary'],
        properties: { match: { type: 'string', enum: MATCHES.concat(['']) }, summary: str }
      },
      headline: str,
      caveats: { type: 'array', items: str }
    }
  };
})();

// v9.1：画面が使う 2 つだけにした（行動・写真の要約・ひとことに書かれたものは、投稿文の読み取り（coach）で取るので重複していた）。出力が短くなり、ヒントが早く届く
const HINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'why_options'],
  properties: {
    subject: { type: 'string' },
    why_options: { type: 'array', items: { type: 'string' } }
  }
};

function callAzureOpenAI_(apiKey, messages, schema, name, maxTokens) {
  const body = {
    messages: messages,
    max_completion_tokens: maxTokens || numProp_('MAX_OUTPUT_TOKENS'),
    response_format: { type: 'json_schema', json_schema: { name: name || 'drop_coach_chat', strict: true, schema: schema || OUTPUT_SCHEMA } }
  };
  const effort = prop_('REASONING_EFFORT');
  if (effort) body.reasoning_effort = effort;
  let r = postAzure_(apiKey, body);
  if (r.code === 400 && body.reasoning_effort && /reasoning/i.test(r.text)) {
    console.warn('reasoning_effort=' + body.reasoning_effort + ' が拒否されたため外して再送します: ' + r.text);
    delete body.reasoning_effort;
    r = postAzure_(apiKey, body);
  }
  let json;
  try {
    json = JSON.parse(r.text);
  } catch (e) {
    console.error('Azure OpenAI non-JSON', r.code, String(r.text).slice(0, 500));
    throw new AppError('AI', 'Azure OpenAI の応答を解釈できません (HTTP ' + r.code + ')');
  }
  if (r.code !== 200) {
    console.error('Azure OpenAI error', r.code, String(r.text).slice(0, 1000));
    const m = String((json.error && json.error.message) || '').slice(0, 200);
    if (r.code === 401) throw new AppError('AI', 'API キーが無効です（' + AZURE_MODEL.secret + ' を確認してください）');
    if (r.code === 404) throw new AppError('AI', 'デプロイ「' + AZURE_MODEL.deployment + '」または api-version が見つかりません');
    if (r.code === 429) throw new AppError('AI', 'Azure OpenAI の利用上限に達しました。少し待ってから再実行してください');
    throw new AppError('AI', 'Azure OpenAI エラー (HTTP ' + r.code + '): ' + m);
  }
  const choice = json.choices && json.choices[0];
  const msg = choice && choice.message;
  if (!msg) throw new AppError('AI', 'AI の応答が空です');
  if (msg.refusal) throw new AppError('AI', 'AI が回答を拒否しました: ' + String(msg.refusal).slice(0, 200));
  if (choice.finish_reason === 'content_filter') throw new AppError('AI', 'Azure のコンテンツフィルターにより応答が停止されました');
  if (choice.finish_reason === 'length') throw new AppError('AI', '出力が上限で途切れました。MAX_OUTPUT_TOKENS を増やしてください');
  if (json.usage) console.log('usage', JSON.stringify(json.usage));
  try {
    return JSON.parse(msg.content);
  } catch (e) {
    throw new AppError('AI', 'AI の出力が JSON ではありません');
  }
}
function postAzure_(apiKey, body) {
  let res;
  try {
    res = UrlFetchApp.fetch(azureUrl_(), {
      method: 'post', contentType: 'application/json',
      headers: { 'api-key': apiKey }, payload: JSON.stringify(body), muteHttpExceptions: true
    });
  } catch (e) {
    console.error('Azure OpenAI fetch failed', e);
    throw new AppError('AI', 'Azure OpenAI に接続できません。endpoint の設定を確認してください');
  }
  return { code: res.getResponseCode(), text: res.getContentText() };
}

/* ============================== 共通 ============================== */
function adjustDailyQuota_(delta) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) { throw new AppError('BUSY', 'アクセスが集中しています。少し待ってから再実行してください'); }
  try {
    const props = PropertiesService.getScriptProperties();
    const key = KEY.QUOTA + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    const n = Number(props.getProperty(key) || 0);
    if (delta > 0 && n >= numProp_('DAILY_LIMIT')) return false;
    props.setProperty(key, String(Math.max(0, n + delta)));
    if (delta > 0 && n === 0) {
      props.getKeys().filter(k => k.indexOf(KEY.QUOTA) === 0 && k !== key).forEach(k => props.deleteProperty(k));
    }
    return true;
  } finally {
    lock.releaseLock();
  }
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
function fail_(code, message) { return json_({ ok: false, code: code, message: message }); }

/* ============================ 動作確認用 ============================ */
function checkSetup() {
  const url = azureUrl_();
  if (!/^https:\/\/[^\s<>"']+$/.test(url)) console.error('★ AZURE_MODEL.endpoint に HTML 等が混入しています: ' + AZURE_MODEL.endpoint);
  ['APP_PASSWORD', AZURE_MODEL.secret, 'PROMPT_URL_CHAT']
    .forEach(k => console.log(k + ': ' + (PropertiesService.getScriptProperties().getProperty(k) ? '設定済み' : '★未設定')));
  console.log('MODEL: ' + AZURE_MODEL.name + ' / URL: ' + url);
  console.log('画像: ' + (boolProp_('ENABLE_IMAGES') ? 'ON' : 'OFF') + ' / 最大 ' + numProp_('MAX_IMAGES') + ' 枚 / detail=' + prop_('IMAGE_DETAIL') + ' / 1 日の上限 ' + numProp_('DAILY_LIMIT') + ' 回');
  clearPromptCache();
  const p = loadPrompt_('chat');
  console.log('プロンプト（投稿文）version=' + p.version + ' system=' + p.system.length + '字 user=' + p.user.length + '字' +
    (/\{\{\s*(TARGET|ANSWERS|WORKING)\s*\}\}/.test(p.user) ? '' : ' ★{{TARGET}}/{{ANSWERS}}/{{WORKING}} が見つかりません'));
  const h = loadPrompt_('hint');
  console.log('プロンプト（ヒント）version=' + h.version + ' system=' + h.system.length + '字 user=' + h.user.length + '字');
}
// 8x8 灰色の JPEG（モデル疎通用。内容の解析結果には意味がない）
const TEST_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDuqKKKAP/Z';

/** ヒントの経路確認（エディタから実行） */
function testHint() {
  const login = JSON.parse(handleLogin_({ password: prop_('APP_PASSWORD') }).getContent());
  const out = JSON.parse(handleHint_({ token: login.token, variant: 'chat', context: { event: 'test' }, target: { text: 'コーヒーおいしかった' } }).getContent());
  console.log(out.ok ? 'OK ' + (out.elapsed_ms / 1000) + '秒 ' + JSON.stringify(out.result) : JSON.stringify(out));
}
/** チャット版の経路確認（エディタから実行） */
function testChat() {
  const login = JSON.parse(handleLogin_({ password: prop_('APP_PASSWORD') }).getContent());
  const out = JSON.parse(handleCoach_({
    token: login.token, force: true, variant: 'chat',
    context: { event: 'test', sample_total: 0 },
    target: { text: '豆本かわいい！', source: 'first', image_data: TEST_JPEG },
    answers: [
      { q: 'そのとき、だれと一緒でしたか？', a: '作った人・お店の人と話した（隣のビルの経理さん）' },
      { q: '豆本の、どこがかわいかったですか？', a: '手づくり感・技、小さな文字' },
      { q: 'どんな気持ちになりましたか？（選んだ順）', a: 'かわいい、刺激をもらった' },
      { q: 'このあと、どうしたいですか？', a: '自分もやってみたい' }
    ],
    working_text: '豆本かわいい！\n作ったのは隣のビルの経理さん\nとくに手づくり感！\n私もやってみたい',
    references: []
  }).getContent());
  console.log(out.ok ? 'OK ' + JSON.stringify(out.result) : JSON.stringify(out));
}

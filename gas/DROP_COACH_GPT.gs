/**
 * DROP Coach（投稿改善アシスタント）— Google Apps Script（Web アプリ）  ※画像解析・方式 B 版
 * ------------------------------------------------------------
 * drop_coach.html から「改善したい投稿（T）」と「目的に応じた参考投稿（R1, R2 …）」を受け取り、
 * 本文と画像をまとめて Azure OpenAI に渡して改善案を作らせ、JSON で返す。
 *
 * ■ 画像の受け取り方（方式 B）
 *   画像サーバー（adpf-poc.com）は Google のサーバー（UrlFetchApp）からのアクセスを 403 で拒否するため、
 *   利用者のブラウザで画像を取得・縮小した data URL（image_data）を受け取って使う。
 *   - image_data は先頭バイトを検査し、JPEG / PNG / WEBP の本物の画像だけを受け付ける
 *   - image_data が無い投稿だけ、GAS から画像 URL を取得する（Referer 付き。失敗しても本文のみで続行）
 *
 * ■ v4 の変更（投稿前チェック）
 *   - mode:"draft" を追加。利用者が端末からアップロードした画像（data URL のみ・URL なし）と本文を T として分析する
 *     （draft の T は数値を持たない：{ id:"T", status:"投稿前", text_len, text, name? }）
 *   - 出力に viewpoint（本文の独自の視点・気づき：最優先）と photo.match（画像と本文の一致度）を追加
 *   - プロンプトに {{MODE}} を追加（このスクリプトと drop_coach_prompt.md は同時に更新すること）
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login", "password":"..." }
 *       → { ok:true, token:"...", expires_in:秒 }
 *   { "action":"coach", "token":"...", "mode":"posted|draft",
 *     "goal":{ "type":"pv|like|other", "label":"...", "note":"..." },
 *     "context":{...},
 *     "target":{ id:"T", ..., image:"https://...", image_data:"data:image/jpeg;base64,..." },
 *       ※ mode:"draft" のときは { text, name?, image_data? }（image_data はアップロード画像。URL は不要）
 *     "references":[{ id:"R1", ..., image:"https://...", image_data:"data:..." }],
 *     "instructions":"追加の指示（任意）", "force":false }
 *       → { ok:true, cached, elapsed_ms, model, prompt_version, generated_at,
 *           images_used, images_from_browser, images_note, result:{...} }
 *   エラー時 → { ok:false, code:"AUTH|LOCKED|LIMIT|BUSY|BAD_REQUEST|CONFIG|AI|SERVER", message:"..." }
 *
 * ■ スクリプトプロパティ
 *   必須
 *     APP_PASSWORD        … 画面で入力させるパスワード
 *     AZURE_API_KEY_LUNA  … Azure OpenAI の API キー（※リポジトリには絶対に書かない）
 *     PROMPT_URL_WITH_SAMPLE … prompt/drop_coach_with_sample.md の raw URL
 *     PROMPT_URL_NO_SAMPLE   … prompt/drop_coach_no_sample.md の raw URL
 *   任意
 *     PROMPT_URL_COMMON   … prompt/drop_coach_common.md の raw URL（未設定なら種類別ファイルと同じフォルダの drop_coach_common.md）
 *   任意（括弧内は既定値）
 *     REASONING_EFFORT (none) / MAX_OUTPUT_TOKENS (3000) / TOKEN_TTL_SEC (21600)
 *     RESULT_CACHE_SEC (21600) / PROMPT_CACHE_SEC (300) / DAILY_LIMIT (100) / MAX_FAILS (30)
 *     MAX_REFS (20) / MAX_TEXT (300) / MAX_INSTR (400) / MAX_GOAL (200)
 *     ENABLE_IMAGES     (true)  … false で画像を一切使わない
 *     IMAGE_URL_PREFIX  (https://adpf-poc.com/machiapps/userdata/photos/) … 受け付ける画像 URL の先頭（カンマ区切り可）
 *     MAX_IMAGES        (9)     … 1 回に使う画像の上限（T 優先 → R の上から）
 *     MAX_IMAGE_BYTES   (1500000) … 1 枚あたりのサイズ上限（デコード後）
 *     IMAGE_DETAIL      (low)   … low / high / auto
 *     SERVER_IMAGE_FETCH (true) … image_data が無い画像を GAS から取得するか（403 環境なら false で時間短縮）
 *     IMAGE_REFERER     (https://adpf-poc.com/machiapps/) … GAS から取得するときに付ける Referer
 *
 * ■ 前提
 *   デプロイ gpt-6-luna が画像入力（vision）に対応していること。
 *   未対応で画像付きリクエストが 400 になった場合は、自動で画像を外して 1 回だけ再送する。
 *
 * ■ デプロイ
 *   貼り替え後、エディタで checkSetup() を実行 → デプロイを管理 → 編集 → 新バージョン（URL は変わらない）
 *   ウェブアプリ設定：次のユーザーとして実行「自分」/ アクセスできるユーザー「全員」
 *
 * ■ v5 の変更（サンプル参照版／サンプルなし版）
 *   - req.variant を追加（"with_sample" | "no_sample"。省略時は従来どおり）
 *     with_sample … drop_coach_with_sample.html。T（下書き）とサンプル投稿 R（ランダム抽出・PV/いいね無し）を比較
 *     no_sample   … drop_coach_no_sample.html。T（下書き）だけで分析。references は空でよい
 *   - variant 指定時は PV・いいね・順位を一切使わない（goal の pv/like 判定・「上位投稿」前提をしない）
 *   - プロンプトは variant ごとに切替：PROMPT_URL_WITH_SAMPLE / PROMPT_URL_NO_SAMPLE（未設定なら PROMPT_URL）
 *
 * ■ v6 の変更（プロンプトを共通部分と種類別に分割）
 *   - プロンプトを 3 ファイルに分割：drop_coach_common.md（共通）＋ drop_coach_no_sample.md / drop_coach_with_sample.md（種類別）
 *     SYSTEM は「共通 → 種類別」の順につなげ、共通の USER（出力内容）は種類別 USER の {{COMMON}} の位置に差し込む（無ければ末尾）
 *   - variant（with_sample / no_sample）を必須にした。variant の無い従来版（posted モード・PROMPT_URL）は廃止
 *
 * ■ v6.1 の変更
 *   - 出力に category（A：心が動いた／B：人とつながった／C：会社の印象）を追加。result.category = { code, label, direction }
 *   - viewpoint.summary の先頭に「分類：X ラベル。」を GAS 側で付ける（ログで振り分けに使う）
 *   - D（その他：A〜C に当てはまらない）を追加
 *
 * ■ v7 の変更（2026/11/12）
 *   - 分類を KPI①②③判定に変更（A=①挑戦／B=②属性横断／C=③信頼・心理的安全性／D=該当なし）。CATEGORIES の label・direction のみ変更
 *   - プロンプト（drop_coach_common.md）側で 5W1H の点検と KPI 判定を行う。出力スキーマ・処理は変更なし
 *
 * ■ v7.1 の変更（2026/11/12）ステップ形式のコーチ
 *   - 画面は「初回の分析 → 問いに 1 つずつ答える（画面内で文面に反映。途中で終えてもよい）→ 仕上げ」の流れ。AI の分析は 1 人 2 回まで
 *   - 問いの上限を 3 → 6 に変更（LIMITS.QUESTIONS）
 *   - 仕上げのとき req.answers（[{ q:"問い", a:"回答" }, …]）と req.working_text（画面で答えを【 】に入れた今の文面）を受け取り、
 *     プロンプトの {{ANSWERS}} に差し込む（無ければ「（なし：初回）」）。テンプレートに {{ANSWERS}} が無い場合は末尾に追記する
 *   - answers・working_text を結果キャッシュのキーに含める（回答が変われば再分析）
 *   - 見本投稿（サンプル）の写真：許可 URL 以外でも、ブラウザから届いた正しい画像データ（image_data）があれば使う
 *     （json/sample_img の写真を AI に渡すため。GAS から外部取得はしない）
 *   - 1 回に使う画像の上限 MAX_IMAGES の既定値を 6 → 9 に変更（入力した画像 1 枚＋見本 8 枚）
 *
 * ■ 貼り付け時の注意
 *   貼り付け後に「&g」+「t;」「&l」+「t;」「<a」+「 href」で検索し 0 件であることを確認すること。
 */

/* ============================== 設定 ============================== */
const AZURE_MODEL = {
  name: 'gpt-6-luna',
  deployment: 'gpt-6-luna',
  endpoint: 'https://uhr65-mkgfgxtk-eastus2.openai.azure.com',
  api_version: '2025-04-01-preview',
  secret: 'AZURE_API_KEY_LUNA'
};
const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
const DEFAULTS = {
  REASONING_EFFORT: 'none',
  MAX_OUTPUT_TOKENS: 4000,   // v4：viewpoint 追加に伴い 3000 → 4000
  TOKEN_TTL_SEC: 21600,
  RESULT_CACHE_SEC: 21600,
  PROMPT_CACHE_SEC: 300,
  DAILY_LIMIT: 100,
  MAX_FAILS: 30,
  MAX_REFS: 20,
  MAX_TEXT: 300,
  MAX_INSTR: 400,
  MAX_GOAL: 200,
  ENABLE_IMAGES: 'true',
  IMAGE_URL_PREFIX: 'https://adpf-poc.com/machiapps/userdata/photos/',
  MAX_IMAGES: 9,   // v7.1：入力した画像 1 枚＋見本投稿 8 枚
  MAX_IMAGE_BYTES: 1500000,
  IMAGE_DETAIL: 'low',
  SERVER_IMAGE_FETCH: 'true',
  IMAGE_REFERER: 'https://adpf-poc.com/machiapps/'
};
const CACHE_MAX_SEC = 21600;
const FAIL_WINDOW_SEC = 900;
const KEY = { FAIL: 'coach_auth_fail', PROMPT: 'coach_prompt_v6_', TOKEN: 'coach_tok_', RESULT: 'coach_res5_', QUOTA: 'coach_count_' };
const LIMITS = { STRENGTHS: 3, WEAKNESSES: 3, TRAITS: 3, TIPS: 3, EVIDENCE: 3, IMPROVEMENTS: 4, POINTS: 3, CAVEATS: 2, FOUND: 3, QUESTIONS: 6 };
const LEVELS = ['低', '中', '高'];
const MATCHES = ['一致', '一部一致', '不一致'];
/* v7：コクヨKPI（3つのカルチャー変革）による判定。記号は出力スキーマ A〜D のまま */
const CATEGORIES = {
  A: { label: '①挑戦', direction: '「誰の何に刺激を受けた？自分なら何をやってみたい？」方向へ' },
  B: { label: '②属性横断', direction: '「どんな人と、何で通じ合った？その後どうしたい？」方向へ' },
  C: { label: '③信頼・心理的安全性', direction: '「職場の誰の、どんな一面？職場でどうしたくなった？」方向へ' },
  D: { label: '該当なし', direction: 'まず「何を・なぜ」を補い、いちばん近いKPIの芽を1つ聞く' }
};
const MODES = {
  posted: '投稿済み（DROP に投稿済みの投稿を改善する。T の数値は参考情報）',
  draft: '投稿前（利用者が投稿前にチェックしたい下書き。T には PV・いいね・順位・投稿日時が無い）'
};
/* v5：variant（サンプル参照版／サンプルなし版）。いずれも T は投稿前の下書き（mode:"draft" 扱い） */
const VARIANTS = {
  with_sample: { promptProp: 'PROMPT_URL_WITH_SAMPLE', needRefs: true,  label: 'サンプル投稿を参考に投稿を改善',
    mode: '投稿前（これから投稿する下書き）。サンプル投稿（PV・いいねによらずランダムに抽出）と比較する' },
  no_sample:   { promptProp: 'PROMPT_URL_NO_SAMPLE',   needRefs: false, label: '投稿を改善',
    mode: '投稿前（これから投稿する下書き）。参考投稿は無く、T の本文と画像だけで分析する' }
};
const DRAFT_IMAGE_KEY = 'upload:';   // アップロード画像の擬似 URL（キャッシュキー用。外部取得はしない）
const SAMPLE_IMAGE_KEY = 'sample:';  // v7.1：見本投稿の写真（ブラウザから届いた画像データ）の擬似 URL
const GOAL_TYPES = { pv: 'PVを上げる', like: 'いいねを増やす', other: 'その他の目的' };
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif)$/i;
const VARIANT_CFG_ = v => (Object.prototype.hasOwnProperty.call(VARIANTS, v) ? VARIANTS[v] : null);
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== undefined) return v;
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
      default:      throw new AppError('BAD_REQUEST', '不明な action です');
    }
  } catch (err) {
    if (err instanceof AppError) return fail_(err.code, err.message);
    console.error((err && err.stack) || err);
    return fail_('SERVER', 'サーバーエラーが発生しました。管理者は GAS の実行ログを確認してください');
  }
}
function doGet() {
  return json_({ ok: true, service: 'drop-coach-ai', version: 6, modes: Object.keys(MODES), variants: Object.keys(VARIANTS), images: boolProp_('ENABLE_IMAGES'), time: new Date().toISOString() });
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

/* ============================== 改善案生成 ============================== */
function handleCoach_(req) {
  const t0 = Date.now();
  if (!checkToken_(req.token)) {
    throw new AppError('AUTH', 'ログインの有効期限が切れました。パスワードを再入力してください');
  }
  const apiKey = prop_(AZURE_MODEL.secret);
  if (!apiKey) throw new AppError('CONFIG', 'スクリプトプロパティ ' + AZURE_MODEL.secret + ' が未設定です');

  const variant = VARIANT_CFG_(req.variant) ? String(req.variant) : '';
  const vcfg = VARIANT_CFG_(variant);
  if (!vcfg) throw new AppError('BAD_REQUEST', 'variant（' + Object.keys(VARIANTS).join(' / ') + '）を指定してください');
  // variant 指定時は常に下書き（draft）扱い。PV・いいねは使わない
  const mode = vcfg || req.mode === 'draft' ? 'draft' : 'posted';
  const goal = vcfg ? sanitizeVariantGoal_(req.goal, vcfg) : sanitizeGoal_(req.goal);
  const target = mode === 'draft' ? sanitizeDraft_(req.target) : sanitizePost_(req.target, 'T');
  if (!target) throw new AppError('BAD_REQUEST', mode === 'draft' ? '投稿前チェックの本文が空です' : '改善対象の投稿がありません');
  const uploadRejected = mode === 'draft' && target._rejected;
  delete target._rejected;
  const references = vcfg ? (vcfg.needRefs ? sanitizeSamples_(req.references) : []) : sanitizeRefs_(req.references);
  if (!references.length && (!vcfg || vcfg.needRefs)) throw new AppError('BAD_REQUEST', vcfg ? 'サンプル投稿がありません' : '参考投稿がありません');
  const context = vcfg ? sanitizeVariantContext_(req.context) : sanitizeContext_(req.context);
  const instructions = sanitizeText_(req.instructions, numProp_('MAX_INSTR'));
  const answers = sanitizeAnswers_(req.answers);
  const workingText = answers.length ? sanitizeText_(req.working_text, 400) : '';

  // 画像は投稿オブジェクトから切り離して管理（テキスト JSON には URL・データを入れない）
  const imageReqs = pickImages_([target].concat(references));

  const prompt = loadPrompt_(variant);
  const model = AZURE_MODEL.name;

  // キャッシュキーは画像 URL ＋「ブラウザ画像の有無」で判定（base64 本体は含めない）
  const cache = CacheService.getScriptCache();
  const cacheKey = KEY.RESULT + sha256_(JSON.stringify([
    model, prompt.version, variant, mode, goal, context, target, references, instructions, answers, workingText,
    imageReqs.map(x => [x.id, x.url, !!x.dataUrl]), prop_('IMAGE_DETAIL')
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
  if (!adjustDailyQuota_(+1)) throw new AppError('LIMIT', '本日の AI 分析回数の上限に達しました');

  // ブラウザから届いた画像はそのまま使い、無いものだけ GAS で取得（失敗分は除外して続行）
  const fromBrowser = imageReqs.filter(x => x.dataUrl);
  const rest = imageReqs.filter(x => !x.dataUrl);
  const fetched = rest.length && boolProp_('SERVER_IMAGE_FETCH') ? fetchImages_(rest) : [];
  const order = imageReqs.map(x => x.id);
  const images = fromBrowser.concat(fetched).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const notes = [];
  if (uploadRejected) notes.push('アップロード画像を読み取れなかったため、本文のみで解析しました');
  const missing = imageReqs.filter(x => !images.some(y => y.id === x.id)).map(x => x.id);
  if (missing.length) notes.push('画像を取得できなかった投稿: ' + missing.join(', '));

  const refIds = references.map(r => r.id);
  const vars = {
    MODE: vcfg ? vcfg.mode : MODES[mode],
    GOAL: goal.label + (goal.note ? '\n目的の詳細: ' + goal.note : ''),
    GOAL_METRIC: vcfg ? 'なし（PV・いいねは使わない）' : goal.type === 'pv' ? 'PV（閲覧数）' : goal.type === 'like' ? 'いいね数' : '自由記述の目的（PV・いいねは参考値）',
    CONTEXT: JSON.stringify(context),
    TARGET: JSON.stringify(target),
    REFERENCES: references.length ? JSON.stringify(references) : '（なし）',
    REF_IDS: refIds.length ? refIds.join(', ') : '（なし）',
    INSTRUCTIONS: instructions || '（なし）',
    ANSWERS: answers.length ? (workingText ? '今の文面（画面で答えを【 】に入れたもの）:\n' + workingText + '\n\n' : '') +
      answers.map((x, i) => 'Q' + (i + 1) + ': ' + x.q + '\nA' + (i + 1) + ': ' + x.a).join('\n') : '（なし：初回）',
    IMAGE_IDS: images.length ? images.map(x => x.id).join(', ') : '（なし）'
  };
  let userText = fillTemplate_(prompt.user, vars);
  const tplRaw = prompt.user.replace(/\\/g, '');
  if (instructions && !/\{\{\s*INSTRUCTIONS\s*\}\}/.test(tplRaw)) userText += '\n\n### 利用者からの追加の指示\n' + instructions;
  if (images.length && !/\{\{\s*IMAGE_IDS\s*\}\}/.test(tplRaw)) userText += '\n\n### 添付画像のある投稿 ID\n' + vars.IMAGE_IDS;
  if (answers.length && !/\{\{\s*ANSWERS\s*\}\}/.test(tplRaw)) userText += '\n\n### コーチへの回答（これまでの問いと回答）\n' + vars.ANSWERS;

  const noImageNote = '\n\n※今回は画像が添付されていません。photo は空（match と summary は空文字、tips と evidence_ids は空配列）で返してください。';
  const textOnly = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: userText + noImageNote }
  ];
  const withImages = images.length ? [
    { role: 'system', content: prompt.system },
    { role: 'user', content: buildUserContent_(userText, images) }
  ] : null;

  let data, imagesUsed = images.length;
  try {
    if (withImages) {
      try {
        data = callAzureOpenAI_(apiKey, withImages);
      } catch (err) {
        if (err instanceof AppError && err.code === 'AI' && /image|vision|content.*type|HTTP 400/i.test(err.message)) {
          console.warn('画像付きリクエストが拒否されたためテキストのみで再送します: ' + err.message);
          notes.push('AI が画像を受け付けなかったため、本文のみで解析しました');
          imagesUsed = 0;
          data = callAzureOpenAI_(apiKey, textOnly);
        } else {
          throw err;
        }
      }
    } else {
      data = callAzureOpenAI_(apiKey, textOnly);
    }
  } catch (err) {
    adjustDailyQuota_(-1);
    throw err;
  }

  const payload = {
    ok: true,
    cached: false,
    model: model,
    prompt_version: prompt.version,
    generated_at: new Date().toISOString(),
    images_used: imagesUsed,
    images_from_browser: imagesUsed ? fromBrowser.length : 0,
    images_note: notes.join(' / '),
    result: normalizeResult_(data, new Set(['T'].concat(refIds)), new Set(imagesUsed ? images.map(x => x.id) : []))
  };
  if (variant) payload.variant = variant;
  // 参考投稿が無い場合（no_sample）は reference_insights を空にする
  if (!references.length) payload.result.reference_insights = { summary: '', traits: [], evidence_ids: [] };
  try {
    cache.put(cacheKey, JSON.stringify(payload), Math.min(numProp_('RESULT_CACHE_SEC'), CACHE_MAX_SEC));
  } catch (e) { /* 100KB 超などは無視 */ }
  payload.elapsed_ms = Date.now() - t0;
  return json_(payload);
}

/* ---------- 画像 ---------- */
/** 許可プレフィックスに一致する https URL だけを受け付ける */
function sanitizeImageUrl_(v) {
  const u = String(v == null ? '' : v).trim();
  if (!u || u.length > 500 || !/^https:\/\/[^\s"'<>\\]+$/.test(u)) return '';
  if (/\.\.|%2e%2e/i.test(u)) return '';
  const prefixes = String(prop_('IMAGE_URL_PREFIX') || '').split(',').map(x => x.trim()).filter(Boolean);
  return prefixes.some(p => u.indexOf(p) === 0) ? u : '';
}
/** 先頭バイトから画像形式を判定 */
function sniffType_(b) {
  const u = i => (b[i] === undefined ? -1 : b[i] & 0xff);
  if (u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF) return 'image/jpeg';
  if (u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) return 'image/png';
  if (u(0) === 0x47 && u(1) === 0x49 && u(2) === 0x46) return 'image/gif';
  if (u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 && u(8) === 0x57 && u(9) === 0x45) return 'image/webp';
  return '';
}
/**
 * ブラウザから届いた data URL を検証。形式・サイズ・先頭バイトが正しいものだけ返す。
 * 申告された MIME と中身が一致しない場合は中身の形式に合わせて組み直す。
 */
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
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return '';
  return type === m[1] ? s : 'data:' + type + ';base64,' + m[2];
}
/** 投稿から画像を取り出し、上限枚数まで選ぶ（T 優先 → R の上から）。投稿オブジェクトからは削除 */
function pickImages_(posts) {
  const enabled = boolProp_('ENABLE_IMAGES');
  const max = Math.max(0, numProp_('MAX_IMAGES'));
  const out = [];
  posts.forEach(p => {
    const url = p.image, data = p.image_data;
    delete p.image; delete p.image_data;
    if (enabled && url && out.length < max) out.push({ id: p.id, url: url, dataUrl: data || '' });
  });
  return out;
}
/** GAS から画像を取得（image_data が無い分のみ）。Referer 付き・先頭バイト判定。失敗は除外 */
function fetchImages_(reqs) {
  if (!reqs.length) return [];
  const maxBytes = numProp_('MAX_IMAGE_BYTES');
  const referer = String(prop_('IMAGE_REFERER') || '');
  const opt = url => ({ url: url, muteHttpExceptions: true, followRedirects: true,
    headers: Object.assign({ Accept: 'image/*' }, referer ? { Referer: referer } : {}) });
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(reqs.map(r => opt(r.url)));
  } catch (e) {
    console.warn('image fetchAll failed', e);
    return [];
  }
  const out = [];
  responses.forEach((res, i) => {
    try {
      const code = res.getResponseCode();
      if (code !== 200) { console.warn('image HTTP ' + code + ' (server fetch): ' + reqs[i].url); return; }
      const blob = res.getBlob();
      const bytes = blob.getBytes();
      if (!bytes.length || bytes.length > maxBytes) { console.warn('image size rejected (' + bytes.length + '): ' + reqs[i].url); return; }
      const header = String(blob.getContentType() || '').split(';')[0].trim();
      const type = sniffType_(bytes) || (IMAGE_TYPES.test(header) ? header : '');
      if (!IMAGE_TYPES.test(type)) { console.warn('image type rejected (' + (header || '?') + '): ' + reqs[i].url); return; }
      out.push({ id: reqs[i].id, url: reqs[i].url, dataUrl: 'data:' + type + ';base64,' + Utilities.base64Encode(bytes) });
    } catch (e) {
      console.warn('image convert failed: ' + reqs[i].url, e);
    }
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

/* ---------- 入力整形 ---------- */
const num_ = v => (isFinite(Number(v)) ? Number(v) : 0);
const str_ = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function sanitizeGoal_(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const type = Object.prototype.hasOwnProperty.call(GOAL_TYPES, g.type) ? g.type : 'pv';
  const note = type === 'other' ? sanitizeText_(g.note, numProp_('MAX_GOAL')) : '';
  if (type === 'other' && !note) throw new AppError('BAD_REQUEST', '「その他の目的」の内容が空です');
  return { type: type, label: GOAL_TYPES[type], note: note };
}
function sanitizePost_(p, id) {
  if (!p || typeof p !== 'object') return null;
  const o = {
    id: id,
    like: num_(p.like), pv: num_(p.pv), like_rate: num_(p.like_rate),
    like_rank: num_(p.like_rank), pv_rank: num_(p.pv_rank),
    date: str_(p.date, 10), hour: str_(p.hour, 2),
    gender: str_(p.gender, 10), age: str_(p.age, 10),
    text_len: num_(p.text_len), text: str_(p.text, numProp_('MAX_TEXT'))
  };
  if (Array.isArray(p.groups)) o.groups = p.groups.filter(g => g === 'like_top' || g === 'pv_top');
  if (p.name) o.name = str_(p.name, 40);
  // 画像は「許可された URL」があるときだけ受け付ける（image_data 単独は不可）。pickImages_ で取り出して削除する
  const img = sanitizeImageUrl_(p.image);
  if (img) {
    o.image = img;
    const data = sanitizeImageData_(p.image_data);
    if (data) o.image_data = data;
  }
  return o;
}
/**
 * 投稿前チェック（mode:"draft"）の T。数値・日時は持たない。
 * 画像は利用者がアップロードしたもの（data URL のみ）。検証を通れば擬似 URL「upload:<hash>」を付けて pickImages_ に渡す。
 */
function sanitizeDraft_(p) {
  if (!p || typeof p !== 'object') return null;
  const text = str_(p.text, numProp_('MAX_TEXT'));
  if (!text) return null;
  const o = { id: 'T', status: '投稿前', text_len: str_(p.text, 100000).length, text: text };
  if (p.name) o.name = str_(p.name, 40);
  if (p.image_data) {
    const data = sanitizeImageData_(p.image_data);
    if (data) {
      o.image = DRAFT_IMAGE_KEY + sha256_(data).slice(0, 24);
      o.image_data = data;
    } else {
      o._rejected = true;
    }
  }
  return o;
}

function sanitizeRefs_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(p => p && typeof p === 'object')
    .slice(0, numProp_('MAX_REFS'))
    .map((p, i) => sanitizePost_(p, 'R' + (i + 1)));
}
function sanitizeContext_(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    event: str_(c.event, 60),
    total_posts: num_(c.total_posts),
    avg_like: num_(c.avg_like), avg_pv: num_(c.avg_pv), avg_like_rate: num_(c.avg_like_rate),
    ref_basis: str_(c.ref_basis, 20), ref_top_n: num_(c.ref_top_n),
    ref_pool_size: num_(c.ref_pool_size), ref_pool_filter: str_(c.ref_pool_filter, 120)
  };
}
/* ---------- v5：variant 用 ---------- */
/** variant 時の目的：PV/いいねの区分は使わず、画面から届いた説明（note）だけを参考情報として使う */
function sanitizeVariantGoal_(raw, vcfg) {
  const g = raw && typeof raw === 'object' ? raw : {};
  return { type: 'other', label: vcfg.label, note: sanitizeText_(g.note, numProp_('MAX_GOAL')) };
}
/** サンプル投稿（PV・いいね・順位なし）。画像は許可 URL のときだけ（ブラウザ縮小データ付き可） */
function sanitizeSamples_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(p => p && typeof p === 'object')
    .slice(0, numProp_('MAX_REFS'))
    .map((p, i) => {
      const o = {
        id: 'R' + (i + 1),
        date: str_(p.date, 10), hour: str_(p.hour, 2),
        gender: str_(p.gender, 10), age: str_(p.age, 10),
        text_len: num_(p.text_len), text: str_(p.text, numProp_('MAX_TEXT'))
      };
      if (p.name) o.name = str_(p.name, 40);
      const img = sanitizeImageUrl_(p.image);
      const data = p.image_data ? sanitizeImageData_(p.image_data) : '';
      if (img) {
        o.image = img;
        if (data) o.image_data = data;
      } else if (data) {
        // v7.1：許可 URL 以外（見本投稿の写真など）は、ブラウザから届いた画像データだけを使う（GAS から取得しない）
        o.image = SAMPLE_IMAGE_KEY + sha256_(data).slice(0, 24);
        o.image_data = data;
      }
      return o;
    })
    .filter(o => o.text);
}
/** v7.1：ステップ形式のコーチの「これまでの問いと回答」。最大 8 件・問い 100 字・回答 150 字 */
function sanitizeAnswers_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(x => x && typeof x === 'object')
    .slice(0, 8)
    .map(x => ({ q: str_(x.q, 100), a: str_(x.a, 150) }))
    .filter(x => x.q && x.a);
}
function sanitizeVariantContext_(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const o = { ref_basis: str_(c.ref_basis, 60) };
  if (c.event) o.event = str_(c.event, 60);
  if (c.sample_total !== undefined) o.sample_total = num_(c.sample_total);
  if (c.ref_n !== undefined) o.ref_n = num_(c.ref_n);
  return o;
}

function sanitizeText_(raw, max) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/^[ \t]*#+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** AI 出力を画面が想定する形に整える */
function normalizeResult_(data, validIds, imageIds) {
  const d = data && typeof data === 'object' ? data : {};
  const text = v => (typeof v === 'string' ? v : '');
  const list = (v, max) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x).slice(0, max) : []);
  const ids = (v, set) => [...new Set(list(v, Infinity).filter(id => (set || validIds).has(id)))].slice(0, LIMITS.EVIDENCE);
  const level = v => (LEVELS.indexOf(v) >= 0 ? v : '');
  const obj = v => (v && typeof v === 'object' ? v : {});
  const dg = obj(d.diagnosis), ri = obj(d.reference_insights), rw = obj(d.rewrite), ph = obj(d.photo), vp = obj(d.viewpoint);
  return {
    category: Object.prototype.hasOwnProperty.call(CATEGORIES, d.category)
      ? { code: d.category, label: CATEGORIES[d.category].label, direction: CATEGORIES[d.category].direction }
      : { code: '', label: '', direction: '' },
    headline: text(d.headline),
    viewpoint: {
      level: level(vp.level),
      // ログの「視点の診断」列で振り分けられるよう、先頭に分類を付ける（AI が付けた「分類：…」は除いて付け直す）
      summary: (CATEGORIES[d.category] ? '分類：' + d.category + ' ' + CATEGORIES[d.category].label + '。' : '') +
        text(vp.summary).replace(/^\s*分類[：:][^。]*。\s*/, ''),
      found: list(vp.found, LIMITS.FOUND),
      questions: list(vp.questions, LIMITS.QUESTIONS)
    },
    diagnosis: {
      summary: text(dg.summary),
      strengths: list(dg.strengths, LIMITS.STRENGTHS),
      weaknesses: list(dg.weaknesses, LIMITS.WEAKNESSES)
    },
    reference_insights: {
      summary: text(ri.summary),
      traits: list(ri.traits, LIMITS.TRAITS),
      evidence_ids: ids(ri.evidence_ids)
    },
    photo: imageIds.size ? {
      match: imageIds.has('T') && MATCHES.indexOf(ph.match) >= 0 ? ph.match : '',   // 一致度は T の画像がある時だけ
      summary: text(ph.summary),
      tips: list(ph.tips, LIMITS.TIPS),
      evidence_ids: ids(ph.evidence_ids, imageIds)
    } : { match: '', summary: '', tips: [], evidence_ids: [] },
    improvements: (Array.isArray(d.improvements) ? d.improvements : [])
      .filter(a => a && typeof a === 'object' && typeof a.title === 'string' && a.title)
      .slice(0, LIMITS.IMPROVEMENTS)
      .map(a => ({
        title: a.title,
        detail: text(a.detail),
        example: text(a.example),
        impact: level(a.impact),
        effort: level(a.effort),
        evidence_ids: ids(a.evidence_ids)
      })),
    rewrite: { text: text(rw.text), points: list(rw.points, LIMITS.POINTS) },
    caveats: list(d.caveats, LIMITS.CAVEATS)
  };
}

/* ============================ プロンプト ============================ */
function loadPrompt_(variant) {
  const vcfg = VARIANT_CFG_(variant);
  if (!vcfg) throw new AppError('BAD_REQUEST', 'variant（' + Object.keys(VARIANTS).join(' / ') + '）を指定してください');
  const cacheKey = KEY.PROMPT + variant;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);
  const variantUrl = normalizePromptUrl_(prop_(vcfg.promptProp), vcfg.promptProp);
  const commonUrl = prop_('PROMPT_URL_COMMON')
    ? normalizePromptUrl_(prop_('PROMPT_URL_COMMON'), 'PROMPT_URL_COMMON')
    : variantUrl.replace(/[^/]*$/, 'drop_coach_common.md');
  const common = parsePrompt_(fetchPromptText_(commonUrl, 'PROMPT_URL_COMMON'));
  const own = parsePrompt_(fetchPromptText_(variantUrl, vcfg.promptProp));
  // SYSTEM：共通 → 種類別。USER：種類別の {{COMMON}} に共通 USER を差し込む（無ければ末尾）
  const commonRe = /\{\{\s*COMMON\s*\}\}/;
  const user = commonRe.test(own.user) ? own.user.replace(commonRe, () => common.user) : own.user + '\n\n' + common.user;
  const prompt = {
    system: common.system + '\n\n' + own.system,
    user: user,
    version: sha256_(common.version + ':' + own.version).slice(0, 10)
  };
  cache.put(cacheKey, JSON.stringify(prompt), Math.min(numProp_('PROMPT_CACHE_SEC'), CACHE_MAX_SEC));
  return prompt;
}
function fetchPromptText_(url, propName) {
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    console.error('prompt fetch failed: ' + url, e);
    throw new AppError('CONFIG', 'プロンプトファイルに接続できません。管理者は ' + propName + ' を確認してください');
  }
  const code = res.getResponseCode();
  if (code !== 200) {
    console.error('prompt fetch HTTP ' + code + ': ' + url);
    throw new AppError('CONFIG', 'プロンプトファイルを取得できません（HTTP ' + code + '）。管理者は ' + propName + ' を確認してください');
  }
  return res.getContentText('UTF-8');
}
function normalizePromptUrl_(url, propName) {
  const u = String(url || '').trim();
  if (!u) throw new AppError('CONFIG', 'スクリプトプロパティ ' + (propName || 'PROMPT_URL_*') + ' が未設定です');
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? [RAW_GITHUB_BASE, m[1], m[2], m[3]].join('/') : u;
}
function parsePrompt_(rawText) {
  if (/^\s*<(!doctype|html)/i.test(rawText)) {
    throw new AppError('CONFIG', 'プロンプトが HTML で返りました。PROMPT_URL_* に raw URL を指定してください');
  }
  const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const m = text.match(/^#{2,3}[ \t]*SYSTEM[ \t]*\n([\s\S]*?)^#{2,3}[ \t]*USER[ \t]*\n([\s\S]*)$/im);
  if (!m) throw new AppError('CONFIG', 'プロンプトファイルに「## SYSTEM」「## USER」の見出しがありません');
  return { system: m[1].trim(), user: m[2].trim(), version: sha256_(text).slice(0, 10) };
}
function fillTemplate_(tpl, vars) {
  return tpl.replace(/\{\{\s*([\w\\]+?)\s*\}\}/g, (all, k) => {
    const name = k.replace(/\\/g, '');
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all;
  });
}
function clearPromptCache() {
  CacheService.getScriptCache().removeAll(Object.keys(VARIANTS).map(k => KEY.PROMPT + k));
  console.log('プロンプトのキャッシュを削除しました');
}

/* ============================== Azure OpenAI ============================== */
const OUTPUT_SCHEMA = (() => {
  const strArr = { type: 'array', items: { type: 'string' } };
  const level = { type: 'string', enum: LEVELS };
  return {
    type: 'object',
    additionalProperties: false,
    // 出力順＝評価順（視点 → 画像の一致 → 診断 → … → 結論）。strict モードではこの順に生成される
    required: ['category', 'viewpoint', 'photo', 'diagnosis', 'reference_insights', 'improvements', 'rewrite', 'headline', 'caveats'],
    properties: {
      category: { type: 'string', enum: Object.keys(CATEGORIES) },
      viewpoint: {
        type: 'object', additionalProperties: false,
        required: ['level', 'summary', 'found', 'questions'],
        properties: { level: level, summary: { type: 'string' }, found: strArr, questions: strArr }
      },
      photo: {
        type: 'object', additionalProperties: false,
        required: ['match', 'summary', 'tips', 'evidence_ids'],
        properties: { match: { type: 'string', enum: MATCHES.concat(['']) }, summary: { type: 'string' }, tips: strArr, evidence_ids: strArr }
      },
      diagnosis: {
        type: 'object', additionalProperties: false,
        required: ['summary', 'strengths', 'weaknesses'],
        properties: { summary: { type: 'string' }, strengths: strArr, weaknesses: strArr }
      },
      reference_insights: {
        type: 'object', additionalProperties: false,
        required: ['summary', 'traits', 'evidence_ids'],
        properties: { summary: { type: 'string' }, traits: strArr, evidence_ids: strArr }
      },
      improvements: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['title', 'detail', 'example', 'impact', 'effort', 'evidence_ids'],
          properties: {
            title: { type: 'string' }, detail: { type: 'string' }, example: { type: 'string' },
            impact: level, effort: level, evidence_ids: strArr
          }
        }
      },
      rewrite: {
        type: 'object', additionalProperties: false,
        required: ['text', 'points'],
        properties: { text: { type: 'string' }, points: strArr }
      },
      headline: { type: 'string' },
      caveats: strArr
    }
  };
})();

function callAzureOpenAI_(apiKey, messages) {
  const body = {
    messages: messages,
    max_completion_tokens: numProp_('MAX_OUTPUT_TOKENS'),
    response_format: { type: 'json_schema', json_schema: { name: 'drop_coach', strict: true, schema: OUTPUT_SCHEMA } }
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
  ['APP_PASSWORD', AZURE_MODEL.secret].concat(Object.keys(VARIANTS).map(v => VARIANTS[v].promptProp))
    .forEach(k => console.log(k + ': ' + (prop_(k) ? '設定済み' : '★未設定')));
  console.log('PROMPT_URL_COMMON: ' + (prop_('PROMPT_URL_COMMON') ? '設定済み' : '未設定（種類別ファイルと同じフォルダの drop_coach_common.md を使用）'));
  console.log('MODEL: ' + AZURE_MODEL.name + ' / URL: ' + url);
  console.log('画像解析: ' + (boolProp_('ENABLE_IMAGES') ? 'ON' : 'OFF') + ' / GAS からの取得: ' + (boolProp_('SERVER_IMAGE_FETCH') ? 'ON' : 'OFF') +
    ' / 最大 ' + numProp_('MAX_IMAGES') + ' 枚 / detail=' + prop_('IMAGE_DETAIL'));
  clearPromptCache();
  Object.keys(VARIANTS).forEach(v => {
    const p = loadPrompt_(v);
    console.log('プロンプト[' + v + '] version=' + p.version + ' system=' + p.system.length + '字 user=' + p.user.length + '字' +
      (/\{\{\s*COMMON\s*\}\}/.test(p.user) ? ' ★{{COMMON}} が残っています' : ''));
  });
}
// 8x8 灰色の JPEG（モデル疎通用。内容の解析結果には意味がない）
const TEST_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDuqKKKAP/Z';

/** v5：サンプル参照版（variant:"with_sample"）の経路確認（エディタから実行） */
function testWithSample() {
  const login = JSON.parse(handleLogin_({ password: prop_('APP_PASSWORD') }).getContent());
  const out = JSON.parse(handleCoach_({
    token: login.token, force: true, variant: 'with_sample', mode: 'draft',
    goal: { note: 'サンプル投稿と比べて改善する' },
    context: { event: 'test', sample_total: 7, ref_basis: 'サンプル投稿からランダムに抽出（PV・いいねは使わない）', ref_n: 1 },
    target: { text: '階段の手すりの丸みが、触るとひんやりして驚きました。', image_data: TEST_JPEG },
    references: [{ date: '2026-11-09', hour: '20', gender: '男性', age: '30代', text_len: 18, text: '今では珍しい二重螺旋階段と噴水です！', name: 'OMM' }],
    instructions: ''
  }).getContent());
  console.log(out.ok ? 'OK variant=' + out.variant + ' refs_insight=' + JSON.stringify(out.result.reference_insights) : JSON.stringify(out));
}
/** v5：サンプルなし版（variant:"no_sample"・references 空）の経路確認（エディタから実行） */
function testNoSample() {
  const login = JSON.parse(handleLogin_({ password: prop_('APP_PASSWORD') }).getContent());
  const out = JSON.parse(handleCoach_({
    token: login.token, force: true, variant: 'no_sample', mode: 'draft',
    goal: { note: '入力内容だけで改善する' }, context: { ref_basis: 'なし（参考投稿を使わない）' },
    target: { text: '階段の手すりの丸みが、触るとひんやりして驚きました。', image_data: TEST_JPEG },
    references: [], instructions: ''
  }).getContent());
  console.log(out.ok ? 'OK variant=' + out.variant + ' headline=' + out.result.headline : JSON.stringify(out));
}

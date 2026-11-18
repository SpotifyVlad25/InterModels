import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import robotoCyrillic from "@fontsource/roboto/files/roboto-cyrillic-400-normal.woff2";
import robotoLatin from "@fontsource/roboto/files/roboto-latin-400-normal.woff2";

let resvgReady: Promise<void> | undefined;
async function ensureResvg(): Promise<void> {
  resvgReady ??= initWasm(resvgWasm);
  await resvgReady;
}
interface Env {
  DB: D1Database;
  MODEL_BOT_TOKEN: string;
  DIRECTOR_BOT_TOKEN: string;
  SECRETARY_BOT_TOKEN: string;
  DIRECTOR_TELEGRAM_ID: string;
  OWNER_TELEGRAM_ID: string;
  MODEL_WEBHOOK_SECRET: string;
  DIRECTOR_WEBHOOK_SECRET: string;
  SECRETARY_WEBHOOK_SECRET: string;
}
interface TelegramUser { id: number; first_name?: string; last_name?: string; username?: string; }
interface TelegramMessage {
  message_id: number; message_thread_id?: number; from?: TelegramUser; chat: { id: number; type: string };
  text?: string; caption?: string; media_group_id?: string; photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>; document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number }; contact?: { phone_number: string; user_id?: number };
}
interface TelegramCallbackQuery { id: string; from: TelegramUser; data?: string; message?: TelegramMessage; }
interface TelegramUpdate { update_id?: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery; }
interface ModelRow { id: string; first_name: string; last_name: string; phone: string | null; telegram_user_id: string | null; }
interface RegistrationRow { id: string; telegram_user_id: string; candidate_model_ids: string; status: string; }
interface SecretaryModelRow {
  id: string; first_name: string; last_name: string;
  height_cm: number | null; bust_cm: number | null; waist_cm: number | null; hips_cm: number | null;
  clothing_size: string | null; shoe_size: string | null; hair_color: string | null; eye_color: string | null;
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8" },
});
function normalizeName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
function normalizePhone(value: string): string { return value.replace(/\D/g, ""); }
function randomId(): string { return crypto.randomUUID().replace(/-/g, "").slice(0, 12); }
type SecretaryOperationKind = "photo_upload" | "composite" | "composite_batch";
async function startSecretaryOperation(
  env: Env, kind: SecretaryOperationKind, actorId: string, chatId: number, threadId: number, sourceKey?: string,
): Promise<string> {
  const id = randomId();
  await env.DB.prepare(
    "INSERT INTO secretary_operations (id,kind,actor_id,chat_id,thread_id,source_key,status) VALUES (?,?,?,?,?,?, 'running')",
  ).bind(id, kind, actorId, String(chatId), threadId, sourceKey ?? null).run();
  return id;
}
async function getOrStartSecretaryOperation(
  env: Env, kind: SecretaryOperationKind, actorId: string, chatId: number, threadId: number, sourceKey: string,
): Promise<{ id: string; status: string }> {
  const existing = await env.DB.prepare("SELECT id,status FROM secretary_operations WHERE source_key=?")
    .bind(sourceKey).first<{id:string;status:string}>();
  if (existing) return existing;
  const id = await startSecretaryOperation(env, kind, actorId, chatId, threadId, sourceKey);
  return { id, status: "running" };
}
async function assertSecretaryOperationActive(env: Env, operationId?: string): Promise<void> {
  if (!operationId) return;
  const operation = await env.DB.prepare("SELECT status FROM secretary_operations WHERE id=?")
    .bind(operationId).first<{status:string}>();
  if (!operation || operation.status !== "running") throw new Error("SECRETARY_OPERATION_CANCELLED");
}
async function finishSecretaryOperation(env: Env, operationId: string, status: "completed" | "cancelled" | "failed"): Promise<void> {
  await env.DB.prepare("UPDATE secretary_operations SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'")
    .bind(status, operationId).run();
}
function secretaryCancelKeyboard(operationId: string): Record<string, unknown> {
  return { inline_keyboard: [[{ text: "❌ Отменить", callback_data: "op_cancel:" + operationId }]] };
}


async function telegram(token: string, method: string, payload: Record<string, unknown>): Promise<any> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const result: any = await response.json();
  if (!response.ok || !result.ok) {
    console.error("Telegram API error", {
      method,
      chatId: payload.chat_id ?? null,
      threadId: payload.message_thread_id ?? null,
      errorCode: result.error_code ?? response.status,
      description: result.description ?? "Unknown Telegram API error",
    });
    throw new Error(`Telegram API request failed: ${method}`);
  }
  return result;
}
async function sendModel(env: Env, chatId: string | number, text: string, threadId?: number): Promise<void> {
  const payload: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
  if (threadId) payload.message_thread_id = threadId;
  await telegram(env.MODEL_BOT_TOKEN, "sendMessage", payload);
}
async function sendDirector(env: Env, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  const topic = await env.DB.prepare("SELECT chat_id, thread_id FROM bot_topics WHERE bot_key = ?").bind("director").first<{ chat_id: string; thread_id: number }>();
  const payload: Record<string, unknown> = { chat_id: topic?.chat_id ?? env.DIRECTOR_TELEGRAM_ID, text, disable_web_page_preview: true };
  if (topic?.thread_id) payload.message_thread_id = topic.thread_id;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", payload);
}
async function saveTopic(env: Env, botKey: "model" | "director", message: TelegramMessage): Promise<void> {
  if ((message.chat.type !== "group" && message.chat.type !== "supergroup") || !message.message_thread_id) return;
  await env.DB.prepare(
    `INSERT INTO bot_topics (bot_key, chat_id, thread_id) VALUES (?, ?, ?)
     ON CONFLICT(bot_key) DO UPDATE SET chat_id = excluded.chat_id, thread_id = excluded.thread_id`,
  ).bind(botKey, String(message.chat.id), message.message_thread_id).run();
}
async function getActiveModels(env: Env): Promise<ModelRow[]> {
  const result = await env.DB.prepare(
    "SELECT id, first_name, last_name, phone, telegram_user_id FROM models WHERE is_active = 1 AND lifecycle_status = 'active'",
  ).all<ModelRow>();
  return result.results ?? [];
}
async function createRequest(
  env: Env, user: TelegramUser, method: "name" | "phone", submittedValue: string, candidates: ModelRow[], replyChatId: number, replyThreadId?: number,
): Promise<void> {
  const requestId = randomId();
  await env.DB.prepare(
    `INSERT INTO registration_requests
      (id, telegram_user_id, username, telegram_first_name, telegram_last_name, search_method, submitted_value, candidate_model_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(requestId, String(user.id), user.username ?? null, user.first_name ?? null,
    user.last_name ?? null, method, submittedValue, JSON.stringify(candidates.map((m) => m.id))).run();

  const candidateLines = candidates.map((m) => `• ${m.first_name} ${m.last_name} (анкета ${m.id})`).join("\n");
  const userLabel = user.username ? `@${user.username}` : "без username";
  const message = `Поступила новая заявка на подключение InterModels\n\nПользователь: ${user.first_name ?? ""} ${user.last_name ?? ""} (${userLabel})\nTelegram ID: ${user.id}\nСпособ поиска: ${method === "name" ? "ФИО" : "телефон"}\nВведённые данные: ${submittedValue}\n\nНайденные анкеты:\n${candidateLines}\n\nДиректору отправлено уведомление с кнопками для решения. Заявка также отображается в рабочем кабинете.`;
  const keyboard = [
    ...candidates.map((m) => [{ text: `Принять: ${m.first_name} ${m.last_name}`.slice(0, 60), callback_data: `a:${requestId}:${m.id}` }]),
    [{ text: "Отклонить заявку", callback_data: `r:${requestId}` }],
  ];
  await sendDirector(env, message, { inline_keyboard: keyboard });
  if (env.OWNER_TELEGRAM_ID && env.OWNER_TELEGRAM_ID !== env.DIRECTOR_TELEGRAM_ID) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: env.OWNER_TELEGRAM_ID,
      text: message,
      disable_web_page_preview: true,
    });
  }
  await sendModel(env, replyChatId, "Совпадение найдено. Заявка отправлена директору на проверку. Доступ откроется только после её подтверждения.", replyThreadId);
}


const PROFILE_STEPS = [
  { state: "profile_height", field: "height_cm", prompt: "Укажите рост в сантиметрах (например, 183). Можно отправить «пропустить».", numeric: true },
  { state: "profile_weight", field: "weight_kg", prompt: "Укажите вес в килограммах (например, 72). Можно отправить «пропустить».", numeric: true },
  { state: "profile_bust", field: "bust_cm", prompt: "Обхват груди в сантиметрах. Можно отправить «пропустить».", numeric: true },
  { state: "profile_waist", field: "waist_cm", prompt: "Обхват талии в сантиметрах. Можно отправить «пропустить».", numeric: true },
  { state: "profile_hips", field: "hips_cm", prompt: "Обхват бёдер в сантиметрах. Можно отправить «пропустить».", numeric: true },
  { state: "profile_clothing", field: "clothing_size", prompt: "Укажите размер одежды (например, 46 / M). Можно отправить «пропустить».", numeric: false },
  { state: "profile_shoe", field: "shoe_size", prompt: "Укажите размер обуви (например, 42). Можно отправить «пропустить».", numeric: false },
  { state: "profile_hair", field: "hair_color", prompt: "Укажите цвет волос. Можно отправить «пропустить».", numeric: false },
  { state: "profile_eyes", field: "eye_color", prompt: "Укажите цвет глаз. Можно отправить «пропустить».", numeric: false },
] as const;
async function beginModelProfile(env: Env, telegramId: string, chatId: number, threadId?: number): Promise<void> {
  await env.DB.prepare("INSERT INTO model_profiles (model_id) SELECT id FROM models WHERE telegram_user_id = ? ON CONFLICT(model_id) DO NOTHING").bind(telegramId).run();
  const first = PROFILE_STEPS[0];
  await env.DB.prepare("INSERT INTO bot_sessions (telegram_user_id,state,data_json,updated_at) VALUES (?, ?, '{}', CURRENT_TIMESTAMP) ON CONFLICT(telegram_user_id) DO UPDATE SET state=excluded.state,data_json='{}',updated_at=CURRENT_TIMESTAMP").bind(telegramId, first.state).run();
  await sendModel(env, chatId, "Подключение подтверждено! Давайте заполним вашу анкету. Это займёт несколько коротких шагов.\n\n" + first.prompt, threadId);
}
async function handleModelProfileStep(env: Env, telegramId: string, chatId: number, text: string, threadId?: number): Promise<boolean> {
  const session = await env.DB.prepare("SELECT state FROM bot_sessions WHERE telegram_user_id = ?").bind(telegramId).first<{state:string}>();
  const index = PROFILE_STEPS.findIndex((step) => step.state === session?.state);
  if (index < 0) return false;
  const step = PROFILE_STEPS[index], value = text.trim(), skipped = /^(пропустить|skip|—)$/i.test(value);
  let stored: string | number | null = skipped ? null : value;
  if (!skipped && step.numeric) {
    const number = Number(value.replace(",", "."));
    if (!Number.isFinite(number) || number <= 0 || number > 300) {
      await sendModel(env, chatId, "Введите корректное число или отправьте «пропустить».\n\n" + step.prompt, threadId); return true;
    }
    stored = number;
  }
  await env.DB.prepare("INSERT INTO model_profiles (model_id) SELECT id FROM models WHERE telegram_user_id = ? ON CONFLICT(model_id) DO NOTHING").bind(telegramId).run();
  await env.DB.prepare(`UPDATE model_profiles SET ${step.field} = ?, updated_at = CURRENT_TIMESTAMP WHERE model_id = (SELECT id FROM models WHERE telegram_user_id = ?)`).bind(stored, telegramId).run();
  const next = PROFILE_STEPS[index + 1];
  if (next) {
    await env.DB.prepare("UPDATE bot_sessions SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?").bind(next.state, telegramId).run();
    await sendModel(env, chatId, next.prompt, threadId);
  } else {
    await env.DB.prepare("UPDATE bot_sessions SET state = 'profile_complete', updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?").bind(telegramId).run();
    await env.DB.prepare("UPDATE models SET lifecycle_status = 'active' WHERE telegram_user_id = ? AND is_active = 1").bind(telegramId).run();
    await env.DB.prepare(
      `UPDATE profile_refresh_members SET status = 'updated', updated_at = CURRENT_TIMESTAMP
       WHERE model_id = (SELECT id FROM models WHERE telegram_user_id = ?)
         AND status = 'pending'
         AND campaign_id IN (SELECT id FROM profile_refresh_campaigns WHERE status = 'open')`,
    ).bind(telegramId).run();
    await sendModel(env, chatId, "Спасибо! Параметры обновлены. Ваша анкета снова активна в базе InterModels.", threadId);
  }
  return true;
}
async function showModelProfilePrompt(env: Env, telegramId: string, chatId: number, threadId?: number): Promise<void> {
  const session = await env.DB.prepare("SELECT state FROM bot_sessions WHERE telegram_user_id = ?").bind(telegramId).first<{state:string}>();
  const model = await env.DB.prepare("SELECT lifecycle_status FROM models WHERE telegram_user_id = ? AND is_active = 1").bind(telegramId).first<{lifecycle_status:string}>();
  const step = PROFILE_STEPS.find((item) => item.state === session?.state);
  if (step) await sendModel(env, chatId, "Продолжим заполнение анкеты.\\n\\n" + step.prompt, threadId);
  else if (model?.lifecycle_status === "frozen") await sendModel(env, chatId, "🥶\\n\\nУпс, ваша анкета заморожена и временно не отображается в активной базе.\\nОтправьте /profile, чтобы обновить параметры и восстановить доступ.", threadId);
  else if (session?.state === "profile_complete") await sendModel(env, chatId, "Ваша анкета подключена и заполнена. Чтобы изменить данные, отправьте /profile.", threadId);
  else await beginModelProfile(env, telegramId, chatId, threadId);
}

async function handleModelMessage(env: Env, message: TelegramMessage): Promise<void> {
  // Model onboarding and profile updates are private-chat only.
  // Group updates must never be answered or persisted as model topics.
  if (message.chat.type !== "private") return;
  const user = message.from;
  if (!user) return;
  console.info("Model private update", {
    chatId: message.chat.id,
    chatType: message.chat.type,
    senderId: user.id,
    command: (message.text ?? "").trim().slice(0, 80),
  });
  const replyChatId = message.chat.id;
  const replyThreadId = message.message_thread_id;
  if (message.text?.startsWith("/start")) {
    await saveTopic(env, "model", message);
    const linked = await env.DB.prepare("SELECT id FROM models WHERE telegram_user_id = ? AND is_active = 1").bind(String(user.id)).first<{id:string}>();
    if (linked) { await showModelProfilePrompt(env, String(user.id), replyChatId, replyThreadId); return; }
    await env.DB.prepare(`INSERT INTO bot_sessions (telegram_user_id, state, data_json, updated_at)
      VALUES (?, 'awaiting_name', '{}', CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO UPDATE SET state = 'awaiting_name', data_json = '{}', updated_at = CURRENT_TIMESTAMP`).bind(String(user.id)).run();
    await telegram(env.MODEL_BOT_TOKEN, "sendMessage", {
      chat_id: replyChatId, ...(replyThreadId ? { message_thread_id: replyThreadId } : {}),
      text: "Добро пожаловать в InterModels!\n\nВведите имя и фамилию точно так, как они указаны в агентстве. Либо отправьте свой номер телефона кнопкой ниже.",
      reply_markup: { keyboard: [[{ text: "Поделиться контактом", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
    return;
  }
  if (message.text === "/profile") {
    const linked = await env.DB.prepare("SELECT id FROM models WHERE telegram_user_id = ? AND is_active = 1").bind(String(user.id)).first<{id:string}>();
    if (!linked) { await sendModel(env, replyChatId, "Сначала дождитесь подтверждения подключения директором.", replyThreadId); return; }
    await beginModelProfile(env, String(user.id), replyChatId, replyThreadId); return;
  }
  if (message.text && await handleModelProfileStep(env, String(user.id), replyChatId, message.text, replyThreadId)) return;
  if (message.contact) {
    if (message.contact.user_id !== user.id) {
      await sendModel(env, replyChatId, "Отправьте именно свой контакт через кнопку Telegram, а не контакт другого человека.", replyThreadId);
      return;
    }
    const phone = normalizePhone(message.contact.phone_number);
    if (!phone) { await sendModel(env, replyChatId, "Не удалось прочитать номер. Попробуйте ещё раз или введите ФИО.", replyThreadId); return; }
    const models = await getActiveModels(env);
    const matches = models.filter((m) => m.phone && normalizePhone(m.phone) === phone);
    const candidates = matches.filter((m) => !m.telegram_user_id || m.telegram_user_id === String(user.id));
    if (!candidates.length) {
      await sendModel(env, replyChatId, matches.length
        ? "Эта анкета уже привязана к другому Telegram-аккаунту. Обратитесь к директору агентства."
        : "Анкета с таким номером не найдена. Проверьте номер или обратитесь к директору агентства.", replyThreadId);
      return;
    }
    await createRequest(env, user, "phone", message.contact.phone_number, candidates, replyChatId, replyThreadId);
    return;
  }
  if (!message.text) return;
  if (message.text.startsWith("/")) { await sendModel(env, replyChatId, "Для начала регистрации отправьте /start.", replyThreadId); return; }
  const session = await env.DB.prepare("SELECT state FROM bot_sessions WHERE telegram_user_id = ?")
    .bind(String(user.id)).first<{ state: string }>();
  if (!session || session.state !== "awaiting_name") {
    await sendModel(env, replyChatId, "Отправьте /start, чтобы начать подключение.", replyThreadId); return;
  }
  const target = normalizeName(message.text);
  if (target.length < 3) { await sendModel(env, replyChatId, "Введите полные имя и фамилию.", replyThreadId); return; }
  const models = await getActiveModels(env);
  const matches = models.filter((m) => normalizeName(`${m.first_name} ${m.last_name}`) === target);
  const candidates = matches.filter((m) => !m.telegram_user_id || m.telegram_user_id === String(user.id));
  if (!candidates.length) {
    await sendModel(env, replyChatId, matches.length
      ? "Эта анкета уже привязана к другому Telegram-аккаунту. Обратитесь к директору агентства."
      : "Анкета с таким ФИО не найдена. Проверьте написание или обратитесь к директору агентства.", replyThreadId);
    return;
  }
  await createRequest(env, user, "name", message.text.trim(), candidates, replyChatId, replyThreadId);
}

async function answerCallback(env: Env, callback: TelegramCallbackQuery, text: string, alert = false): Promise<void> {
  await telegram(env.DIRECTOR_BOT_TOKEN, "answerCallbackQuery", {
    callback_query_id: callback.id, text, show_alert: alert,
  });
}
async function canManageRequests(env: Env, telegramId: string): Promise<boolean> {
  return hasDirectorAccess(env, telegramId);
}
async function handleDirectorCallback(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  const refreshMatch = data.match(/^comprefresh:([a-f0-9]{12})$/);
  if (refreshMatch) {
    const actorId = String(callback.from.id);
    if (!(await actorHasPermission(env, actorId, "composite.generate"))) {
      await answerCallback(env, callback, "Недостаточно прав для обновления композиток.", true); return;
    }
    const campaignId = refreshMatch[1];
    const campaign = await env.DB.prepare("SELECT id,status FROM profile_refresh_campaigns WHERE id=?")
      .bind(campaignId).first<{id:string;status:string}>();
    if (!campaign || campaign.status !== "completed") {
      await answerCallback(env, callback, "Кампания не найдена или ещё не завершена.", true); return;
    }
    const updated = await env.DB.prepare(
      "SELECT model_id FROM profile_refresh_members WHERE campaign_id=? AND status='updated'",
    ).bind(campaignId).all<{model_id:string}>();
    let queued = 0;
    for (const row of updated.results ?? []) {
      const inserted = await env.DB.prepare(
        "INSERT OR IGNORE INTO composite_refresh_jobs(campaign_id,model_id,status,attempts,last_error,updated_at) VALUES(?,?,'pending',0,NULL,CURRENT_TIMESTAMP)",
      ).bind(campaignId, row.model_id).run();
      queued += inserted.meta?.changes ?? 0;
    }
    await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'composite.refresh.campaign_queued', ?)")
      .bind(randomId(), actorId, JSON.stringify({campaign_id:campaignId,updated_models:updated.results?.length ?? 0,queued})).run();
    await answerCallback(env, callback, queued
      ? "В очередь добавлено моделей: " + queued
      : "Все обновлённые модели уже обработаны или находятся в очереди.");
    if (callback.message) {
      try {
        await telegram(env.DIRECTOR_BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] },
        });
      } catch (error) { console.error("Unable to remove used composite refresh button", error); }
    }
    if (queued) {
      await sendDirector(env, "🔄 Обновление Comp запущено по завершённой кампании. В очереди: " + queued + " моделей. Уже опубликованные композитки повторно в очередь не попадают.");
    }
    return;
  }
  if (!(await canManageRequests(env, String(callback.from.id)))) {
    await answerCallback(env, callback, "Недостаточно прав.", true); return;
  }
  if (data === "composite:create") {
    const msg = callback.message;
    if (!msg || msg.chat.type !== "supergroup" || !msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Кнопка доступна только в теме КОМПОЗИТКИ.", show_alert: true });
      return;
    }
    const topic = await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id=1").first<{chat_id:string;thread_id:number}>();
    if (!topic || topic.chat_id !== String(msg.chat.id) || topic.thread_id !== msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Эта тема не подключена как КОМПОЗИТКИ.", show_alert: true });
      return;
    }
    await env.DB.prepare("INSERT INTO secretary_composite_input_pending(chat_id,thread_id,user_id) VALUES(?,?,?) ON CONFLICT(chat_id,thread_id,user_id) DO UPDATE SET created_at=CURRENT_TIMESTAMP")
      .bind(String(msg.chat.id), msg.message_thread_id, String(callback.from.id)).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Ожидаю список моделей." });
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
      text: "Введите фамилии или ФИО моделей — по одной на строку. Можно отправить сразу несколько, до 20 моделей.",
    });
    return;
  }
  const approve = data.match(/^a:([a-f0-9]{12}):([a-zA-Z0-9_-]{1,40})$/);
  const reject = data.match(/^r:([a-f0-9]{12})$/);

  if (approve) {
    const [, requestId, modelId] = approve;
    const req = await env.DB.prepare("SELECT id, telegram_user_id, candidate_model_ids, status FROM registration_requests WHERE id = ?")
      .bind(requestId).first<RegistrationRow>();
    if (!req || req.status !== "pending") { await answerCallback(env, callback, "Заявка уже обработана или не найдена.", true); return; }
    const ids: string[] = JSON.parse(req.candidate_model_ids);
    if (!ids.includes(modelId)) { await answerCallback(env, callback, "Анкета не относится к этой заявке.", true); return; }
    const model = await env.DB.prepare(
      "SELECT id, first_name, last_name, phone, telegram_user_id FROM models WHERE id = ? AND is_active = 1",
    ).bind(modelId).first<ModelRow>();
    if (!model || (model.telegram_user_id && model.telegram_user_id !== req.telegram_user_id)) {
      await env.DB.prepare("UPDATE registration_requests SET status = 'conflict', decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE id = ? AND status = 'pending'")
        .bind(String(callback.from.id), requestId).run();
      await answerCallback(env, callback, "Анкета уже привязана к другому аккаунту.", true); return;
    }
    const update = await env.DB.prepare(
      "UPDATE models SET telegram_user_id = ?, linked_at = CURRENT_TIMESTAMP WHERE id = ? AND (telegram_user_id IS NULL OR telegram_user_id = ?)",
    ).bind(req.telegram_user_id, modelId, req.telegram_user_id).run();
    if ((update.meta?.changes ?? 0) === 0) { await answerCallback(env, callback, "Не удалось привязать анкету.", true); return; }
    await env.DB.prepare("UPDATE registration_requests SET status = 'approved', decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE id = ? AND status = 'pending'")
      .bind(String(callback.from.id), requestId).run();
    await env.DB.prepare("INSERT INTO model_profiles (model_id) VALUES (?) ON CONFLICT(model_id) DO NOTHING").bind(modelId).run();
    await beginModelProfile(env, req.telegram_user_id, Number(req.telegram_user_id));
    await answerCallback(env, callback, "Модель успешно подключена.");
    if (callback.message) await telegram(env.DIRECTOR_BOT_TOKEN, "editMessageReplyMarkup", {
      chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  if (reject) {
    const requestId = reject[1];
    const req = await env.DB.prepare("SELECT id, telegram_user_id, candidate_model_ids, status FROM registration_requests WHERE id = ?")
      .bind(requestId).first<RegistrationRow>();
    if (!req || req.status !== "pending") { await answerCallback(env, callback, "Заявка уже обработана или не найдена.", true); return; }
    await env.DB.prepare("UPDATE registration_requests SET status = 'rejected', decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE id = ? AND status = 'pending'")
      .bind(String(callback.from.id), requestId).run();
    await sendModel(env, req.telegram_user_id, "Директор не подтвердила подключение. Если вы считаете, что это ошибка, свяжитесь с агентством.");
    await answerCallback(env, callback, "Заявка отклонена.");
    if (callback.message) await telegram(env.DIRECTOR_BOT_TOKEN, "editMessageReplyMarkup", {
      chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] },
    });
  }
}
async function handleDirectorMessage(env: Env, message: TelegramMessage): Promise<void> {
  if (!message.from || !["private", "group", "supergroup"].includes(message.chat.type)) return;
  const senderId = String(message.from.id);
  const isDirector = hasDirectorAccess(env, senderId);
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  if (!isDirector) {
    if (!isGroup) await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: `Доступ пока не подключён. Ваш Telegram ID: ${senderId}. Передайте его администратору InterModels для активации.` });
    return;
  }
  if (message.text?.startsWith("/start")) {
    if (isDirector) await saveTopic(env, "director", message);
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: "InterModels Director подключён. У вас полный доступ.",
    });
  } else if (message.text?.startsWith("/help")) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: "Команды:\n/start — подключить бота\n/help — помощь\n\nУ вас полный доступ к управлению агентством.",
    });
  }
}



async function secretaryAllowed(env: Env, telegramId: string): Promise<boolean> {
  return hasDirectorAccess(env, telegramId);
}
async function findSecretaryModels(env: Env, surname: string): Promise<SecretaryModelRow[]> {
  // SQLite's built-in lower() only folds ASCII by default, so Cyrillic surnames
  // such as «Демаков» can fail to match when the query is lowercased.
  // Fetch active model names and compare with the same Unicode normalization
  // used by the composite command.
  const result = await env.DB.prepare(
    `SELECT m.id, m.first_name, m.last_name,
      p.height_cm, p.bust_cm, p.waist_cm, p.hips_cm,
      p.clothing_size, p.shoe_size, p.hair_color, p.eye_color
     FROM models m LEFT JOIN model_profiles p ON p.model_id = m.id
     WHERE m.is_active = 1 AND m.lifecycle_status = 'active'
     ORDER BY m.last_name, m.first_name LIMIT 500`,
  ).all<SecretaryModelRow>();
  const target = normalizeName(surname);
  return (result.results ?? []).filter((model) => normalizeName(model.last_name).includes(target));
}
function secretaryProfileText(model: SecretaryModelRow): string {
  const lines = [
    `Анкета найдена: ${model.first_name} ${model.last_name}`,
    model.height_cm != null ? `Рост: ${model.height_cm} см` : null,
    model.bust_cm != null ? `Грудь: ${model.bust_cm} см` : null,
    model.waist_cm != null ? `Талия: ${model.waist_cm} см` : null,
    model.hips_cm != null ? `Бёдра: ${model.hips_cm} см` : null,
    model.clothing_size ? `Одежда: ${model.clothing_size}` : null,
    model.shoe_size ? `Обувь: ${model.shoe_size}` : null,
    model.hair_color ? `Волосы: ${model.hair_color}` : null,
    model.eye_color ? `Глаза: ${model.eye_color}` : null,
  ].filter((line): line is string => Boolean(line));
  lines.push("", "Генерация графической композитки ещё подключается. Сейчас доступен поиск анкеты и её параметров.");
  return lines.join("\n");
}
async function sendSecretary(env: Env, chatId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  const payload: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", payload);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
async function getSecretaryPhotoData(env: Env, fileId: string): Promise<string> {
  const file = await telegram(env.SECRETARY_BOT_TOKEN, "getFile", { file_id: fileId });
  const path = file.result?.file_path;
  if (typeof path !== "string" || !path) throw new Error("Telegram photo path missing");
  const imageUrl = "https://api.telegram.org/file/bot" + env.SECRETARY_BOT_TOKEN + "/" + path;
  // Download the original Telegram file without Cloudflare image resizing or JPEG recompression.
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error("Unable to download Telegram image (HTTP " + response.status + ")");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("Original image size is invalid (maximum 20 MB)");
  const headerType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const extension = path.split(".").pop()?.toLowerCase();
  const mime = headerType.startsWith("image/") ? headerType :
    extension === "png" ? "image/png" :
    extension === "webp" ? "image/webp" :
    extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    throw new Error("Unsupported image format. Send JPEG, PNG or WEBP files.");
  }
  return "data:" + mime + ";base64," + bytesToBase64(bytes);
}
function compositeSvg(model: SecretaryModelRow, photos: string[]): string {
  const firstName = (model.first_name || "").trim();
  const surnameInitial = (model.last_name || "").trim().charAt(0);
  const rawName = (firstName + (surnameInitial ? " " + surnameInitial + "." : "")).toUpperCase();
  const name = escapeXml(rawName);
  // The short display name spans the full width beneath photo #3.
  const nameSize = rawName.length > 18 ? 44 : rawName.length > 16 ? 48 : rawName.length > 13 ? 52 : 58;
  const leftValues = [
    model.height_cm != null ? "РОСТ  " + model.height_cm + " СМ" : null,
    model.bust_cm != null ? "ГРУДЬ  " + model.bust_cm + " СМ" : null,
    model.waist_cm != null ? "ТАЛИЯ  " + model.waist_cm + " СМ" : null,
    model.hips_cm != null ? "БЁДРА  " + model.hips_cm + " СМ" : null,
  ];
  const rightValues = [
    model.hair_color ? "ВОЛОСЫ  " + model.hair_color : null,
    model.eye_color ? "ГЛАЗА  " + model.eye_color : null,
    model.clothing_size ? "ОДЕЖДА  " + model.clothing_size : null,
    model.shoe_size ? "ОБУВЬ  " + model.shoe_size : null,
  ];
  // Keep each category in its own column and preserve row positions when a value is absent.
  const renderDetails = (items: Array<string | null>, x: number) => items
    .map((v, i) => {
      if (!v) return "";
      const fontSize = v.length > 25 ? 18 : v.length > 20 ? 20 : 23;
      return `<text x="${x}" y="${1735 + i * 70}" class="detail" font-size="${fontSize}">${escapeXml(v)}</text>`;
    }).join("");
  const details = renderDetails(leftValues, 950) + renderDetails(rightValues, 1240);
  // "meet" preserves the complete source photo: no cropping and no stretching.
  const img = (data: string, x: number, y: number, w: number, h: number) =>
    `<image href="${data}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="2260" viewBox="0 0 1600 2260">
  <rect width="1600" height="2260" fill="#fff"/>
  <text x="90" y="70" class="brand">INTERMODELS</text><text x="1510" y="70" text-anchor="end" class="small">ПОРТФОЛИО МОДЕЛИ</text>
  <defs><clipPath id="a"><rect x="90" y="110" width="820" height="1093"/></clipPath><clipPath id="b"><rect x="950" y="110" width="560" height="700"/></clipPath><clipPath id="c"><rect x="950" y="850" width="560" height="700"/></clipPath><clipPath id="d"><rect x="90" y="1240" width="820" height="820"/></clipPath></defs>
  <g clip-path="url(#a)"><rect x="90" y="110" width="820" height="1093" fill="#f1f1f1"/> ${img(photos[0],90,110,820,1093)}</g>
  <g clip-path="url(#b)"><rect x="950" y="110" width="560" height="700" fill="#f1f1f1"/> ${img(photos[1],950,110,560,700)}</g>
  <g clip-path="url(#c)"><rect x="950" y="850" width="560" height="700" fill="#f1f1f1"/> ${img(photos[2],950,850,560,700)}</g>
  <g clip-path="url(#d)"><rect x="90" y="1240" width="820" height="820" fill="#f1f1f1"/> ${img(photos[3],90,1240,820,820)}</g>
  <text x="950" y="1645" class="name" font-size="${nameSize}">${name}</text>${details}
  <line x1="90" y1="2110" x2="1510" y2="2110" stroke="#222" stroke-width="2"/>
  <text x="445" y="101" text-anchor="middle" class="contact">https://inter-models.ru</text>
  <text x="1155" y="101" text-anchor="middle" class="contact">+7 902 632-32-72</text>
  <text x="1510" y="2210" text-anchor="end" class="logo">INTERMODELS</text>
  <text x="1510" y="2242" text-anchor="end" class="logo-sub">MODEL AGENCY</text>
  <style>
    text{font-family:Roboto,sans-serif;fill:#171717}.brand{font-size:30px;font-weight:700;letter-spacing:8px}.small{font-size:17px;letter-spacing:3px;fill:#777}.eyebrow{font-size:17px;letter-spacing:4px;fill:#777}.name{font-size:58px;font-weight:800;letter-spacing:.5px}.detail{font-size:23px;font-weight:600;letter-spacing:.5px}.contact{font-size:21px;font-weight:500;letter-spacing:1px}.logo{font-size:38px;font-weight:800;letter-spacing:8px}.logo-sub{font-size:17px;font-weight:500;letter-spacing:6px;fill:#777}
  </style></svg>`;
}
function compositeErrorText(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  if (error instanceof ArrayBuffer) return "Binary error payload (" + error.byteLength + " bytes)";
  if (ArrayBuffer.isView(error)) return "Binary error payload (" + error.byteLength + " bytes)";
  try { return JSON.stringify(error); } catch { return String(error); }
}
async function compositeFontBuffer(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") {
    const comma = value.indexOf(",");
    if (value.startsWith("data:") && comma >= 0) {
      const payload = value.slice(comma + 1);
      if (value.slice(0, comma).includes(";base64")) {
        const decoded = atob(payload);
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        return bytes;
      }
      return new TextEncoder().encode(decodeURIComponent(payload));
    }
    if (value.startsWith("wOF2") || value.startsWith("\\u0000\\u0001\\u0000\\u0000")) {
      const bytes = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 255;
      return bytes;
    }
    throw new Error("Font asset import returned a URL/string instead of font bytes");
  }
  throw new Error("Unsupported font asset type: " + Object.prototype.toString.call(value));
}
async function renderCompositePng(env: Env, model: SecretaryModelRow, fileIds: string[], onStage?: (stage: string) => Promise<void>): Promise<Uint8Array> {
  let stage = "init_wasm";
  try {
    await onStage?.("Инициализация графического движка");
    await ensureResvg();
    stage = "download_photos";
    await onStage?.("Загрузка 4 фотографий");
    const photoStartedAt = Date.now();
    const photos = await Promise.all(fileIds.map((id) => getSecretaryPhotoData(env, id)));
    const photoBytes = photos.map((photo) => Math.floor((photo.length * 3) / 4));
    console.info("Composite source photos downloaded", { modelId: model.id, photoBytes, totalPhotoBytes: photoBytes.reduce((sum, size) => sum + size, 0), elapsedMs: Date.now() - photoStartedAt });
    stage = "build_svg";
    await onStage?.("Сборка макета");
    const svg = compositeSvg(model, photos);
    console.info("Composite SVG assembled", { modelId: model.id, svgCharacters: svg.length });
    stage = "prepare_fonts";
    await onStage?.("Подготовка шрифтов");
    const fontBuffers = await Promise.all([compositeFontBuffer(robotoCyrillic), compositeFontBuffer(robotoLatin)]);
    if (fontBuffers.some((font) => font.byteLength < 4 || !((font[0] === 0x77 && font[1] === 0x4f && font[2] === 0x46 && font[3] === 0x32) || (font[0] === 0 && font[1] === 1 && font[2] === 0 && font[3] === 0) || (font[0] === 79 && font[1] === 84 && font[2] === 84 && font[3] === 79)))) {
      throw new Error("Roboto font asset has an unsupported or invalid signature");
    }
    stage = "create_renderer";
    await onStage?.("Создание рендерера Resvg");
    const renderer = new Resvg(svg, { font: { fontBuffers, defaultFontFamily: "Roboto", loadSystemFonts: false } });
    try {
      stage = "rasterize_png";
      await onStage?.("Рендеринг PNG");
      const renderStartedAt = Date.now();
      const rendered = renderer.render();
      console.info("Composite rasterization completed", { modelId: model.id, elapsedMs: Date.now() - renderStartedAt });
      const png = rendered.asPng();
      console.info("Composite PNG encoded", { modelId: model.id, pngBytes: png.byteLength });
      return png;
    } finally { renderer.free(); }
  } catch (error) {
    const details = compositeErrorText(error);
    console.error("Composite PNG render stage failed", { modelId: model.id, renderStage: stage, error: details });
    throw new Error("Composite PNG " + stage + ": " + details.slice(0, 1800));
  }
}

async function saveSecretaryPhotoSet(
  env: Env, modelId: string, photos: Array<{file_id:string;file_unique_id:string}>,
  senderId: string, chatId: number, threadId: number, operationId?: string,
): Promise<void> {
  await assertSecretaryOperationActive(env, operationId);
  if (photos.length !== 4) throw new Error("Для сохранения нужны ровно четыре фотографии.");
  const statements = operationId
    ? [
        env.DB.prepare("DELETE FROM model_telegram_photos WHERE model_id=? AND EXISTS (SELECT 1 FROM secretary_operations WHERE id=? AND status='running')")
          .bind(modelId, operationId),
        ...photos.map((photo, index) => env.DB.prepare(
          "INSERT INTO model_telegram_photos (model_id,position,telegram_file_id,telegram_file_unique_id,uploaded_by,source_chat_id,source_thread_id) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM secretary_operations WHERE id=? AND status='running')",
        ).bind(modelId, index + 1, photo.file_id, photo.file_unique_id, senderId, String(chatId), threadId, operationId)),
        env.DB.prepare("UPDATE secretary_operations SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'")
          .bind(operationId),
      ]
    : [
        env.DB.prepare("DELETE FROM model_telegram_photos WHERE model_id = ?").bind(modelId),
        ...photos.map((photo, index) => env.DB.prepare(
          "INSERT INTO model_telegram_photos (model_id, position, telegram_file_id, telegram_file_unique_id, uploaded_by, source_chat_id, source_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(modelId, index + 1, photo.file_id, photo.file_unique_id, senderId, String(chatId), threadId)),
      ];
  await env.DB.batch(statements);
  if (operationId) {
    const state = await env.DB.prepare("SELECT status FROM secretary_operations WHERE id=?")
      .bind(operationId).first<{status:string}>();
    if (state?.status !== "completed") throw new Error("SECRETARY_OPERATION_CANCELLED");
  }
}
async function handleSecretaryAlbumMessage(env: Env, message: TelegramMessage, senderId: string): Promise<void> {
  const albumId = message.media_group_id!;
  const threadId = message.message_thread_id;
  if (threadId === undefined) return;
  const media = message.photo?.length ? message.photo[message.photo.length - 1] : message.document;
  if (!media) return;
  if (message.document) {
    const mime = (message.document.mime_type ?? "").toLowerCase();
    const fileName = (message.document.file_name ?? "").toLowerCase();
    const supportedByName = /\\.(jpe?g|png|webp)$/.test(fileName);
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime) && !supportedByName) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "Не удалось распознать формат файла. Отправьте 4 изображения JPEG, PNG или WEBP как файлы." });
      return;
    }
  }
  console.info("Secretary album part received", {
    chatId: message.chat.id,
    threadId,
    uploaderId: senderId,
    mediaGroupId: albumId,
    messageId: message.message_id,
    mediaType: message.photo?.length ? "photo" : "document",
    hasCaption: Boolean(message.caption?.trim()),
    fileUniqueIdPresent: Boolean(media.file_unique_id),
  });
  const caption = (message.caption ?? "").trim();
  let modelId: string | null = null;
  if (caption) {
    if (caption.length > 100 || /[\r\n]/.test(caption)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "В подписи укажите только имя и фамилию модели." });
      return;
    }
    const target = normalizeName(caption);
    const models = await getActiveModels(env);
    const matches = models.filter((m) => normalizeName(m.first_name + " " + m.last_name) === target);
    if (matches.length !== 1) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: matches.length ? "Найдено несколько анкет с таким ФИО. Уточните данные в базе." : "Анкета «" + caption + "» не найдена. Проверьте ФИО." });
      return;
    }
    modelId = matches[0].id;
  } else {
    const existing = await env.DB.prepare(
      "SELECT model_id FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? AND model_id IS NOT NULL LIMIT 1",
    ).bind(String(message.chat.id), threadId, senderId, albumId).first<{model_id:string}>();
    modelId = existing?.model_id ?? null;
  }
  await env.DB.prepare(
    `INSERT INTO secretary_photo_album_items
      (chat_id, thread_id, uploader_id, media_group_id, message_id, model_id, telegram_file_id, telegram_file_unique_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, thread_id, uploader_id, media_group_id, message_id) DO UPDATE SET
       model_id = COALESCE(excluded.model_id, secretary_photo_album_items.model_id),
       telegram_file_id = excluded.telegram_file_id,
       telegram_file_unique_id = excluded.telegram_file_unique_id`,
  ).bind(String(message.chat.id), threadId, senderId, albumId, message.message_id, modelId, media.file_id, media.file_unique_id).run();
  const storedAlbum = await env.DB.prepare(
    "SELECT COUNT(*) AS count, MIN(message_id) AS first_message_id, MAX(message_id) AS last_message_id FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?",
  ).bind(String(message.chat.id), threadId, senderId, albumId)
    .first<{count:number;first_message_id:number|null;last_message_id:number|null}>();
  console.info("Secretary album part stored", {
    chatId: message.chat.id,
    threadId,
    uploaderId: senderId,
    mediaGroupId: albumId,
    messageId: message.message_id,
    storedCount: storedAlbum?.count ?? 0,
    firstMessageId: storedAlbum?.first_message_id ?? null,
    lastMessageId: storedAlbum?.last_message_id ?? null,
  });
  if (modelId) {
    await env.DB.prepare(
      "UPDATE secretary_photo_album_items SET model_id = ? WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? AND model_id IS NULL",
    ).bind(modelId, String(message.chat.id), threadId, senderId, albumId).run();
  }
  // Telegram delivers media-group parts as independent webhook updates.
  // A longer settle window lets all four D1 writes finish before finalization.
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const album = await env.DB.prepare(
    "SELECT message_id, model_id, telegram_file_id AS file_id, telegram_file_unique_id AS file_unique_id FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? ORDER BY message_id",
  ).bind(String(message.chat.id), threadId, senderId, albumId)
    .all<{message_id:number;model_id:string|null;file_id:string;file_unique_id:string}>();
  const items = album.results ?? [];
  if (items.length > 4) {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "В альбоме должно быть ровно 4 фотографии. Отправьте комплект заново." });
    return;
  }
  const albumSourceKey = [String(message.chat.id), String(threadId), senderId, albumId].join("|");
  const albumOperation = await getOrStartSecretaryOperation(
    env, "photo_upload", senderId, message.chat.id, threadId, albumSourceKey,
  );
  if (albumOperation.status !== "running") {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id=? AND thread_id=? AND uploader_id=? AND media_group_id=?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    await env.DB.prepare("DELETE FROM secretary_photo_album_status WHERE chat_id=? AND thread_id=? AND uploader_id=? AND media_group_id=?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    return;
  }
  if (items.length !== 4) {
    if (items.length > 0 && message.message_id === Math.max(...items.map((item) => item.message_id))) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS secretary_photo_album_status (
          chat_id TEXT NOT NULL, thread_id INTEGER NOT NULL, uploader_id TEXT NOT NULL,
          media_group_id TEXT NOT NULL, status_message_id INTEGER,
          PRIMARY KEY (chat_id, thread_id, uploader_id, media_group_id)
        )`,
      ).run();
      const status = await env.DB.prepare(
        "SELECT status_message_id FROM secretary_photo_album_status WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?",
      ).bind(String(message.chat.id), threadId, senderId, albumId).first<{status_message_id:number|null}>();
      const text = `Фото: ${items.length}/4`;
      if (status?.status_message_id) {
        await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
          chat_id: message.chat.id, message_id: status.status_message_id, text,
          reply_markup: secretaryCancelKeyboard(albumOperation.id),
        });
      } else {
        const sent = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id, message_thread_id: threadId, text,
          reply_markup: secretaryCancelKeyboard(albumOperation.id),
        });
        const sentMessageId = sent.result?.message_id;
        if (sentMessageId) {
          await env.DB.prepare(
            "INSERT INTO secretary_photo_album_status (chat_id, thread_id, uploader_id, media_group_id, status_message_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, thread_id, uploader_id, media_group_id) DO UPDATE SET status_message_id = excluded.status_message_id",
          ).bind(String(message.chat.id), threadId, senderId, albumId, sentMessageId).run();
        }
      }
    }
    return;
  }
  if (items.some((item) => !item.model_id)) {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id, message_thread_id: threadId,
      text: "Не вижу подпись с именем и фамилией модели. Добавьте «Имя Фамилия» к первому фото альбома и отправьте комплект заново.",
    });
    return;
  }
  const resolvedModelId = items[0].model_id!;
  const claim = await env.DB.prepare(
    "UPDATE secretary_photo_album_items SET processed_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? AND NOT EXISTS (SELECT 1 FROM secretary_photo_album_items active WHERE active.chat_id = ? AND active.thread_id = ? AND active.uploader_id = ? AND active.media_group_id = ? AND active.processed_at >= datetime('now', '-5 minutes'))",
  ).bind(String(message.chat.id), threadId, senderId, albumId, String(message.chat.id), threadId, senderId, albumId).run();
  if ((claim.meta?.changes ?? 0) === 0) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS secretary_photo_album_status (
      chat_id TEXT NOT NULL, thread_id INTEGER NOT NULL, uploader_id TEXT NOT NULL,
      media_group_id TEXT NOT NULL, status_message_id INTEGER,
      PRIMARY KEY (chat_id, thread_id, uploader_id, media_group_id)
    )`,
  ).run();
  const progressStatus = await env.DB.prepare(
    "SELECT status_message_id FROM secretary_photo_album_status WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?",
  ).bind(String(message.chat.id), threadId, senderId, albumId).first<{status_message_id:number|null}>();
  if (progressStatus?.status_message_id) {
    try {
      await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", {
        chat_id: message.chat.id, message_id: progressStatus.status_message_id,
      });
    } catch (error) {
      console.error("Failed to delete photo upload progress message", error);
    }
  }
  await env.DB.prepare(
    "DELETE FROM secretary_photo_album_status WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?",
  ).bind(String(message.chat.id), threadId, senderId, albumId).run();
  if (items.some((item) => item.model_id !== resolvedModelId)) {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "У фотографий альбома должно быть одно ФИО в подписи первого снимка. Отправьте комплект заново." });
    return;
  }
  const newPhotos = items.map(({file_id,file_unique_id}) => ({file_id,file_unique_id}));
  const previous = await env.DB.prepare(
    "SELECT position, telegram_file_id FROM model_telegram_photos WHERE model_id = ? ORDER BY position",
  ).bind(resolvedModelId).all<{position:number;telegram_file_id:string}>();
  const oldPhotos = previous.results ?? [];
  if (oldPhotos.length === 4 && oldPhotos.every((p, i) => p.position === i + 1)) {
    await finishSecretaryOperation(env, albumOperation.id, "completed");
    await env.DB.prepare(
      "INSERT INTO secretary_photo_replacement_pending (chat_id, thread_id, user_id, model_id, photos_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, thread_id, user_id) DO UPDATE SET model_id=excluded.model_id, photos_json=excluded.photos_json, created_at=CURRENT_TIMESTAMP",
    ).bind(String(message.chat.id), threadId, senderId, resolvedModelId, JSON.stringify(newPhotos)).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMediaGroup", {
      chat_id: message.chat.id, message_thread_id: threadId,
      media: oldPhotos.map((p) => ({ type: "photo", media: p.telegram_file_id })),
    });
    const model = await env.DB.prepare("SELECT first_name, last_name FROM models WHERE id = ?").bind(resolvedModelId).first<{first_name:string;last_name:string}>();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id, message_thread_id: threadId,
      text: "⚠️ Такая модель уже есть: " + (model?.first_name ?? "") + " " + (model?.last_name ?? "") + ". Выше — ранее сохранённые фотографии. Хотите заменить их новыми?",
      reply_markup: { inline_keyboard: [[
        { text: "Да, заменить", callback_data: "photo_replace:yes" },
        { text: "Нет, оставить", callback_data: "photo_replace:no" },
      ]] },
    });
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    return;
  }
  const operationId = albumOperation.id;
  await assertSecretaryOperationActive(env, operationId);
  const uploadStatus = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id, message_thread_id: threadId,
    text: "Сохраняю 4 фотографии в MODEL BANK…",
    reply_markup: secretaryCancelKeyboard(operationId),
  });
  const uploadStatusId = uploadStatus.result?.message_id;
  try {
    await saveSecretaryPhotoSet(env, resolvedModelId, newPhotos, senderId, message.chat.id, threadId, operationId);
    await finishSecretaryOperation(env, operationId, "completed");
  } catch (error) {
    const cancelled = error instanceof Error && error.message === "SECRETARY_OPERATION_CANCELLED";
    await finishSecretaryOperation(env, operationId, cancelled ? "cancelled" : "failed");
    if (uploadStatusId) {
      try { await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id, message_id: uploadStatusId,
        text: cancelled ? "Операция отменена. Фотографии не изменены." : "Не удалось сохранить фотографии.",
        reply_markup: { inline_keyboard: [] },
      }); } catch {}
    }
    if (cancelled) return;
    await env.DB.prepare("UPDATE secretary_photo_album_items SET processed_at = NULL WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    throw error;
  }
  await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
    .bind(String(message.chat.id), threadId, senderId, albumId).run();
  if (uploadStatusId) {
    try { await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: message.chat.id, message_id: uploadStatusId }); } catch {}
  }
  const model = await env.DB.prepare("SELECT first_name, last_name FROM models WHERE id = ?").bind(resolvedModelId).first<{first_name:string;last_name:string}>();
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id, message_thread_id: threadId,
    text: "Готово: альбом из 4 фотографий для " + (model?.first_name ?? "") + " " + (model?.last_name ?? "") + " сохранён в правильном порядке.",
    reply_markup: { inline_keyboard: [[{ text: "➕ Создать фотоанкету", callback_data: "photo:create" }]] },
  });
}
async function sendCompositePng(env: Env, chatId: number, threadId: number, png: Uint8Array, caption: string): Promise<number> {
  const endpoint = `https://api.telegram.org/bot${env.SECRETARY_BOT_TOKEN}/`;
  const makeForm = (field: "photo" | "document") => {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("message_thread_id", String(threadId));
    form.set("caption", caption);
    form.set(field, new Blob([png], { type: "image/png" }), "intermodels-composite.png");
    return form;
  };
  // Send as a document first: Telegram preserves the original PNG instead of recompressing it.
  const documentResponse = await fetch(endpoint + "sendDocument", { method: "POST", body: makeForm("document") });
  const documentResult: any = await documentResponse.json().catch(() => null);
  if (documentResponse.ok && documentResult?.ok) return Number(documentResult.result?.message_id);

  const documentError = documentResult?.description ?? `HTTP ${documentResponse.status}`;
  const photoResponse = await fetch(endpoint + "sendPhoto", { method: "POST", body: makeForm("photo") });
  const photoResult: any = await photoResponse.json().catch(() => null);
  if (!photoResponse.ok || !photoResult?.ok) {
    const photoError = photoResult?.description ?? `HTTP ${photoResponse.status}`;
    throw new Error(`Telegram delivery failed (sendDocument: ${documentError}; sendPhoto: ${photoError})`);
  }
  return Number(photoResult.result?.message_id);
}
async function generateCompositeInTopic(env: Env, message: TelegramMessage, rawName: string): Promise<void> {
  const query = normalizeName(rawName);
  const parts = query.split(" ");
  const surname = parts[parts.length - 1] ?? rawName;
  const models = await findSecretaryModels(env, surname);
  const exact = models.filter((m) => normalizeName(m.first_name + " " + m.last_name) === query);
  const matches = exact.length ? exact : models;
  if (!matches.length) {
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: `Модель «${rawName}» не найдена.` }); return;
  }
  if (matches.length > 1) {
    await env.DB.prepare(
      `INSERT INTO secretary_composite_pending (chat_id, thread_id, user_id, surname)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, thread_id, user_id) DO UPDATE SET surname = excluded.surname, created_at = CURRENT_TIMESTAMP`,
    ).bind(String(message.chat.id), message.message_thread_id!, String(message.from!.id), matches[0].last_name).run();
    const keyboard = matches.map((model) => [{
      text: model.first_name.slice(0, 60),
      callback_data: `csel:${model.id}`,
    }]);
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id, message_thread_id: message.message_thread_id,
      text: "Уточните имя:",
      reply_markup: { inline_keyboard: keyboard },
    }); return;
  }
  await env.DB.prepare("DELETE FROM secretary_composite_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ?")
    .bind(String(message.chat.id), message.message_thread_id!, String(message.from!.id)).run();
  const model = matches[0];
  const photoResult = await env.DB.prepare("SELECT position, telegram_file_id FROM model_telegram_photos WHERE model_id = ? ORDER BY position").bind(model.id).all<{position:number;telegram_file_id:string}>();
  const photos = photoResult.results ?? [];
  if (photos.length !== 4 || photos.some((photo, i) => photo.position !== i + 1)) {
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Для этой модели ещё не загружены все четыре фотографии. Сначала добавьте их в тему «MODEL BANK»." }); return;
  }
  const operationId = await startSecretaryOperation(env, "composite", String(message.from!.id), message.chat.id, message.message_thread_id!);
  const status = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id, message_thread_id: message.message_thread_id,
    text: "Готовлю композитку для " + model.first_name + " " + model.last_name + "…",
    reply_markup: secretaryCancelKeyboard(operationId),
  });
  const statusMessageId = status.result?.message_id;
  const startedAt = Date.now();
  let compositeStage = "render_png";
  const updateStage = async (stage: string) => {
    await assertSecretaryOperationActive(env, operationId);
    if (!statusMessageId) return;
    await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
      chat_id: message.chat.id, message_id: statusMessageId,
      text: `Создаю композитку для ${model.first_name} ${model.last_name}…\\n${stage}`,
      reply_markup: secretaryCancelKeyboard(operationId),
    });
  };
  try {
    await assertSecretaryOperationActive(env, operationId);
    const png = await renderCompositePng(env, model, photos.map((p) => p.telegram_file_id), updateStage);
    await assertSecretaryOperationActive(env, operationId);
    compositeStage = "deliver_png";
    await updateStage("Публикация готового PNG");
    await assertSecretaryOperationActive(env, operationId);
    const newMessageId = await sendCompositePng(env, message.chat.id, message.message_thread_id!, png, model.first_name + " " + model.last_name + " · InterModels");
    const oldPublication = await env.DB.prepare("SELECT chat_id,message_id FROM composite_topic_publications WHERE model_id=?")
      .bind(model.id).first<{ chat_id: string; message_id: number }>();
    await assertSecretaryOperationActive(env, operationId);
    if (oldPublication) {
      try { await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: oldPublication.chat_id, message_id: oldPublication.message_id }); }
      catch (deleteError) { console.error("Previous composite could not be deleted", { modelId: model.id, error: compositeErrorText(deleteError) }); }
    }
    await env.DB.prepare(
      `INSERT INTO composite_topic_publications(model_id,chat_id,thread_id,message_id,campaign_id,published_at)
       VALUES(?,?,?,?,NULL,CURRENT_TIMESTAMP)
       ON CONFLICT(model_id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,
         message_id=excluded.message_id,campaign_id=NULL,published_at=CURRENT_TIMESTAMP`,
    ).bind(model.id, String(message.chat.id), message.message_thread_id!, newMessageId).run();
    await finishSecretaryOperation(env, operationId, "completed");
    console.info("Composite generation completed", { modelId: model.id, elapsedMs: Date.now() - startedAt, pngBytes: png.byteLength });
    compositeStage = "delete_status";
    if (statusMessageId) {
      await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", {
        chat_id: message.chat.id, message_id: statusMessageId,
      });
    }
  } catch (error) {
    const cancelled = error instanceof Error && error.message === "SECRETARY_OPERATION_CANCELLED";
    await finishSecretaryOperation(env, operationId, cancelled ? "cancelled" : "failed");
    const details = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
    console.error("Composite generation failed", { modelId: model.id, stage: compositeStage, ...details });
    if (statusMessageId) {
      try {
        await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
          chat_id: message.chat.id, message_id: statusMessageId,
          text: cancelled ? "Операция отменена." : "Не удалось создать композитку. Ошибка записана, можно попробовать ещё раз позже.",
          reply_markup: { inline_keyboard: [] },
        });
      } catch (notifyError) {
        console.error("Unable to report composite generation failure", notifyError);
      }
    }
  }
}
async function generateCompositeBatchInTopic(env: Env, message: TelegramMessage, names: string[]): Promise<void> {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id!;
  let completed = 0;
  const operationId = await startSecretaryOperation(env, "composite_batch", String(message.from!.id), chatId, threadId);
  let wasCancelled = false;
  for (let index = 0; index < names.length; index++) {
    try { await assertSecretaryOperationActive(env, operationId); }
    catch { wasCancelled = true; break; }
    const rawName = names[index].trim();
    const label = `[${index + 1}/${names.length}] ${rawName}`;
    let statusMessageId: number | undefined;
    try {
      const normalized = normalizeName(rawName);
      const parts = normalized.split(" ");
      const surname = parts[parts.length - 1] ?? normalized;
      const candidates = await findSecretaryModels(env, surname);
      const exact = candidates.filter((m) => normalizeName(m.first_name + " " + m.last_name) === normalized);
      const matches = exact.length ? exact : candidates;
      if (!matches.length) throw new Error("Модель не найдена.");
      if (matches.length > 1) throw new Error("Найдено несколько моделей. Укажите имя и фамилию полностью.");
      const model = matches[0];
      const photoResult = await env.DB.prepare("SELECT position, telegram_file_id FROM model_telegram_photos WHERE model_id = ? ORDER BY position")
        .bind(model.id).all<{position:number;telegram_file_id:string}>();
      const photos = photoResult.results ?? [];
      if (photos.length !== 4 || photos.some((photo, i) => photo.position !== i + 1)) {
        throw new Error("В MODEL BANK ещё нет полного комплекта из четырёх фотографий.");
      }
      const status = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: chatId, message_thread_id: threadId,
        text: `В очереди ${label} · готово ${completed}/${names.length}`,
        reply_markup: secretaryCancelKeyboard(operationId),
      });
      statusMessageId = status.result?.message_id;
      const updateStage = async (stage: string) => {
        await assertSecretaryOperationActive(env, operationId);
        if (!statusMessageId) return;
        await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
          chat_id: chatId, message_id: statusMessageId,
          text: `Создание ${label}\n${stage} · готово ${completed}/${names.length}`,
          reply_markup: secretaryCancelKeyboard(operationId),
        });
      };
      await assertSecretaryOperationActive(env, operationId);
      const png = await renderCompositePng(env, model, photos.map((p) => p.telegram_file_id), updateStage);
      await assertSecretaryOperationActive(env, operationId);
      await updateStage("Отправка готового PNG");
      const newMessageId = await sendCompositePng(env, chatId, threadId, png, model.first_name + " " + model.last_name + " · InterModels");
      if (!Number.isSafeInteger(newMessageId) || newMessageId <= 0) throw new Error("Telegram не вернул ID композитки.");
      const oldPublication = await env.DB.prepare("SELECT chat_id,message_id FROM composite_topic_publications WHERE model_id=?")
        .bind(model.id).first<{chat_id:string;message_id:number}>();
      await assertSecretaryOperationActive(env, operationId);
      if (oldPublication) {
        try { await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: oldPublication.chat_id, message_id: oldPublication.message_id }); }
        catch (error) { console.error("Previous composite could not be deleted", { modelId: model.id, error: compositeErrorText(error) }); }
      }
      await env.DB.prepare(
        `INSERT INTO composite_topic_publications(model_id,chat_id,thread_id,message_id,campaign_id,published_at)
         VALUES(?,?,?,?,NULL,CURRENT_TIMESTAMP)
         ON CONFLICT(model_id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,
           message_id=excluded.message_id,campaign_id=NULL,published_at=CURRENT_TIMESTAMP`,
      ).bind(model.id, String(chatId), threadId, newMessageId).run();
      if (statusMessageId) await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: chatId, message_id: statusMessageId });
      completed++;
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      if (details === "SECRETARY_OPERATION_CANCELLED") {
        wasCancelled = true;
        if (statusMessageId) {
          try { await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: statusMessageId, text: "Операция отменена.", reply_markup: { inline_keyboard: [] } }); } catch {}
        }
        break;
      }
      console.error("Composite batch item failed", { label, error: details });
      if (statusMessageId) {
        try { await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: statusMessageId, text: `Не удалось создать ${label}. ${details}` }); }
        catch (notifyError) { console.error("Unable to report composite batch item failure", notifyError); }
      } else {
        await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: chatId, message_thread_id: threadId, text: `Не удалось создать ${label}. ${details}` });
      }
    }
  }
  await finishSecretaryOperation(env, operationId, wasCancelled ? "cancelled" : "completed");
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: chatId, message_thread_id: threadId,
    text: wasCancelled
      ? `Операция отменена. Успешно создано: ${completed} из ${names.length}.`
      : `Обработка списка завершена: ${completed} из ${names.length} композиток создано.`,
    reply_markup: wasCancelled ? undefined : { inline_keyboard: [[{ text: "➕ Создать композитку", callback_data: "composite:create" }]] },
  });
}
async function handleSecretaryGroupMessage(env: Env, message: TelegramMessage): Promise<void> {
  if (!message.from || (message.chat.type !== "group" && message.chat.type !== "supergroup")) return;
  const senderId = String(message.from.id);
  const command = (message.text ?? "").trim();
  console.info("Secretary group update", {
    chatId: message.chat.id,
    threadId: message.message_thread_id ?? null,
    senderId,
    command: command.slice(0, 120),
  });
  if (!message.message_thread_id) {
    if (command.toLowerCase() === "/comp" || command.toLowerCase().startsWith("/comp ") || command.toLowerCase().startsWith("/comp@")) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "Композитку можно запросить только внутри темы «КОМПОЗИТКИ».",
      });
    }
    return;
  }
  if (/^\/composite_setup(?:@\w+)?$/i.test(command)) {
    if (!hasDirectorAccess(env, senderId)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Настроить тему композиток может только владелец или директор." }); return;
    }
    await env.DB.prepare("INSERT INTO secretary_composite_topics (id, chat_id, thread_id, configured_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, thread_id=excluded.thread_id, configured_by=excluded.configured_by")
      .bind(String(message.chat.id), message.message_thread_id, senderId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Тема «КОМПОЗИТКИ» подключена. Нажмите «Создать композитку», чтобы ввести одну или несколько фамилий.",
      reply_markup: { inline_keyboard: [[{ text: "➕ Создать композитку", callback_data: "composite:create" }]] } }); return;
  }
  const compositeTopic = await env.DB.prepare("SELECT chat_id, thread_id FROM secretary_composite_topics WHERE id = 1").first<{chat_id:string;thread_id:number}>();
  const isCompositeTopic = Boolean(compositeTopic && compositeTopic.chat_id === String(message.chat.id) && compositeTopic.thread_id === message.message_thread_id);
  const isCompCommand = command.toLowerCase() === "/comp" || command.toLowerCase().startsWith("/comp ") || command.toLowerCase().startsWith("/comp@");
  if (isCompCommand && !isCompositeTopic) {
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: compositeTopic
        ? "Команда /comp работает только в зарегистрированной теме «КОМПОЗИТКИ». Перейдите в неё и повторите команду."
        : "Тема «КОМПОЗИТКИ» ещё не подключена. В нужной теме выполните /composite_setup.",
    });
    return;
  }
  if (isCompositeTopic) {
    if (!(await secretaryAllowed(env, senderId))) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id,
        text: "У вас нет права создавать композитки. Попросите директора выдать доступ.",
      });
      return;
    }
    const pendingInput = await env.DB.prepare(
      "SELECT 1 AS pending FROM secretary_composite_input_pending WHERE chat_id=? AND thread_id=? AND user_id=?",
    ).bind(String(message.chat.id), message.message_thread_id, senderId).first<{pending:number}>();
    if (pendingInput && command && !command.startsWith("/")) {
      await env.DB.prepare("DELETE FROM secretary_composite_input_pending WHERE chat_id=? AND thread_id=? AND user_id=?")
        .bind(String(message.chat.id), message.message_thread_id, senderId).run();
      const requestedNames = command.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
      if (!requestedNames.length || requestedNames.length > 20 || requestedNames.some((name) => name.length > 100)) {
        await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Отправьте от 1 до 20 фамилий или ФИО — по одной модели на строку." });
        return;
      }
      await generateCompositeBatchInTopic(env, message, requestedNames);
      return;
    }
    const compCommand = command.match(/^\/comp(?:@\w+)?\s+(.+)$/i);
    if (compCommand) {
      await generateCompositeInTopic(env, message, compCommand[1].trim()); return;
    }
    if (command.startsWith("/")) {
      await env.DB.prepare("DELETE FROM secretary_composite_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ?")
        .bind(String(message.chat.id), message.message_thread_id, senderId).run();
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Команда: /comp Фамилия или /comp Имя Фамилия" });
      return;
    }
    return;
  }
  if (/^\/new(?:@\w+)?$/i.test(command)) {
    if (!hasDirectorAccess(env, senderId)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, message_thread_id: message.message_thread_id,
        text: "Создать фототеку может только владелец или директор.",
      });
      return;
    }
    await env.DB.prepare("INSERT INTO secretary_photo_topics (id, chat_id, thread_id, configured_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, thread_id=excluded.thread_id, configured_by=excluded.configured_by")
      .bind(String(message.chat.id), message.message_thread_id, senderId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id, message_thread_id: message.message_thread_id,
      text: "Режим добавления фотографий включён. Отправьте одним альбомом ровно 4 оригинальных фото. В подписи к первому фото укажите точное имя и фамилию модели, например: Анастасия Деревянкина. Модель должна уже существовать в основной базе. Фото сохранятся в её фототеку «MODEL BANK».",
    });
    return;
  }
  if (/^\/comp_setup(?:@\w+)?$/i.test(command)) {
    if (!hasDirectorAccess(env, senderId)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Настроить фототеку может только владелец или директор." });
      return;
    }
    await env.DB.prepare("INSERT INTO secretary_photo_topics (id, chat_id, thread_id, configured_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, thread_id=excluded.thread_id, configured_by=excluded.configured_by")
      .bind(String(message.chat.id), message.message_thread_id, senderId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Тема «MODEL BANK» подключена. Отправляйте альбом из 4 фотографий: подпись «Имя Фамилия» у первого снимка." });
    return;
  }
  const topic = await env.DB.prepare("SELECT chat_id, thread_id FROM secretary_photo_topics WHERE id = 1").first<{chat_id:string;thread_id:number}>();
  if (!topic || topic.chat_id !== String(message.chat.id) || topic.thread_id !== message.message_thread_id) return;
  if (!(await secretaryAllowed(env, senderId))) {
    if (message.photo?.length || message.document) {
      console.warn("MODEL BANK photo upload rejected: sender has no photo/composite permission", { senderId, chatId: message.chat.id, threadId: message.message_thread_id ?? null });
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, message_thread_id: message.message_thread_id,
        text: "У вас нет доступа к загрузке фотографий в MODEL BANK. Попросите владельца или директора выдать доступ «Управление фотографиями» или «Создание композиток».",
      });
    }
    return;
  }
  if (!message.photo?.length && !message.document) return;
  if (message.document) {
    const mime = (message.document.mime_type ?? "").toLowerCase();
    const fileName = (message.document.file_name ?? "").toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime) && !/\\.(jpe?g|png|webp)$/.test(fileName)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Не удалось распознать формат файла. Отправьте JPEG, PNG или WEBP." });
      return;
    }
  }
  if (message.media_group_id) {
    await handleSecretaryAlbumMessage(env, message, senderId);
    return;
  }
  const bestPhoto = message.photo?.length ? message.photo[message.photo.length - 1] : message.document!;
  const caption = (message.caption ?? "").trim();
  if (caption) {
    if (caption.length > 100 || /[\r\n]/.test(caption)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "В подписи укажите только имя и фамилию модели." });
      return;
    }
    const target = normalizeName(caption);
    const models = await getActiveModels(env);
    const matches = models.filter((m) => normalizeName(m.first_name + " " + m.last_name) === target);
    if (matches.length !== 1) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: matches.length ? "Найдено несколько анкет с таким ФИО. Уточните данные в базе." : "Анкета «" + caption + "» не найдена. Проверьте ФИО." });
      return;
    }
    const model = matches[0];
    const initialPhotos = [{ file_id: bestPhoto.file_id, file_unique_id: bestPhoto.file_unique_id }];
    await env.DB.prepare("INSERT INTO secretary_photo_batches (chat_id, thread_id, uploader_id, model_id, next_position, photos_json, updated_at) VALUES (?, ?, ?, ?, 2, ?, CURRENT_TIMESTAMP) ON CONFLICT(chat_id, thread_id, uploader_id) DO UPDATE SET model_id=excluded.model_id, next_position=2, photos_json=excluded.photos_json, updated_at=CURRENT_TIMESTAMP")
      .bind(String(message.chat.id), message.message_thread_id, senderId, model.id, JSON.stringify(initialPhotos)).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Принято: " + model.first_name + " " + model.last_name + ". Фото 1 из 4. Отправьте ещё три фото подряд." });
    return;
  }
  const batch = await env.DB.prepare("SELECT model_id, next_position, photos_json FROM secretary_photo_batches WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND updated_at >= datetime('now', '-30 minutes')")
    .bind(String(message.chat.id), message.message_thread_id, senderId).first<{model_id:string;next_position:number;photos_json:string}>();
  if (!batch || batch.next_position < 2 || batch.next_position > 4) {
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Начните набор с первого фото и подписи «Имя Фамилия»." });
    return;
  }
  const stagedPhotos = JSON.parse(batch.photos_json) as Array<{file_id:string;file_unique_id:string}>;
  stagedPhotos.push({ file_id: bestPhoto.file_id, file_unique_id: bestPhoto.file_unique_id });
  const next = batch.next_position + 1;
  await env.DB.prepare("UPDATE secretary_photo_batches SET next_position = ?, photos_json = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND thread_id = ? AND uploader_id = ?")
    .bind(next, JSON.stringify(stagedPhotos), String(message.chat.id), message.message_thread_id, senderId).run();
  const model = await env.DB.prepare("SELECT first_name, last_name FROM models WHERE id = ?").bind(batch.model_id).first<{first_name:string;last_name:string}>();
  if (next === 5) await saveSecretaryPhotoSet(env, batch.model_id, stagedPhotos, senderId, message.chat.id, message.message_thread_id);
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: next === 5 ? "Готово: для " + (model?.first_name ?? "") + " " + (model?.last_name ?? "") + " сохранены все 4 фотографии." : "Фото " + batch.next_position + " из 4 принято. Осталось " + (4 - batch.next_position) + ".",
    ...(next === 5 ? { reply_markup: { inline_keyboard: [[{ text: "➕ Создать фотоанкету", callback_data: "photo:create" }]] } } : {}),
  });
}
async function sendSecretaryCompositeSources(env: Env, chatId: number, model: SecretaryModelRow): Promise<void> {
  const result = await env.DB.prepare("SELECT position, telegram_file_id FROM model_telegram_photos WHERE model_id = ? ORDER BY position").bind(model.id).all<{position:number;telegram_file_id:string}>();
  const photos = result.results ?? [];
  if (photos.length !== 4 || photos.some((photo, index) => photo.position !== index + 1)) {
    await sendSecretary(env, chatId, secretaryProfileText(model).replace("Генерация графической композитки ещё подключается. Сейчас доступен поиск анкеты и её параметров.", "Фотографии ещё не загружены полностью. В теме «MODEL BANK» нужны четыре снимка."));
    return;
  }
  await sendSecretary(env, chatId, secretaryProfileText(model));
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMediaGroup", {
    chat_id: chatId,
    media: photos.map((photo, index) => ({ type: "photo", media: photo.telegram_file_id, ...(index === 0 ? { caption: model.first_name + " " + model.last_name + " · фото 1/4" } : {}) })),
  });
}

async function handleSecretaryMessage(env: Env, message: TelegramMessage): Promise<void> {
  if (!message.from) return;
  if (message.chat.type === "group" || message.chat.type === "supergroup") { await handleSecretaryGroupMessage(env, message); return; }
  if (message.chat.type !== "private") return;
  const userId = String(message.from.id);
  if (!(await secretaryAllowed(env, userId))) {
    await sendSecretary(env, message.chat.id, "Доступ к секретарю InterModels не подключён.");
    return;
  }
  const text = (message.text ?? "").trim();
  if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendSecretary(env, message.chat.id,
      "Секретарь InterModels\n\nДля создания композиток перейдите в тему «КОМПОЗИТКИ» и используйте кнопку «➕ Создать композитку».");
    return;
  }
  const command = text.match(/^\/comp(?:@\w+)?(?:\s+(.+))?$/i);
  if (!command) {
    await sendSecretary(env, message.chat.id, "Используйте команду: /comp Фамилия");
    return;
  }
  const surname = (command[1] ?? "").trim();
  if (!surname) {
    await sendSecretary(env, message.chat.id, "Укажите фамилию: /comp Фамилия");
    return;
  }
  if (surname.length > 80 || /[\r\n]/.test(surname)) {
    await sendSecretary(env, message.chat.id, "Проверьте фамилию и попробуйте ещё раз.");
    return;
  }
  const models = await findSecretaryModels(env, surname);
  if (!models.length) {
    await sendSecretary(env, message.chat.id, `Модели с фамилией «${surname}» не найдены.`);
    return;
  }
  if (models.length === 1) {
    await sendSecretaryCompositeSources(env, message.chat.id, models[0]);
    return;
  }
  const keyboard = models.map((model) => [{
    text: `${model.first_name} ${model.last_name}`.slice(0, 60),
    callback_data: `comp:${model.id}`,
  }]);
  await sendSecretary(env, message.chat.id, "Найдено несколько моделей. Выберите нужную:", { inline_keyboard: keyboard });
}
async function handleSecretaryCallback(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  if (!(await secretaryAllowed(env, String(callback.from.id)))) {
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id, text: "Доступ не подключён.", show_alert: true,
    });
    return;
  }
  const data = callback.data ?? "";
  const cancelMatch = data.match(/^op_cancel:([a-f0-9]{12})$/);
  if (cancelMatch) {
    const operationId = cancelMatch[1];
    const operation = await env.DB.prepare("SELECT kind,source_key FROM secretary_operations WHERE id=? AND actor_id=?")
      .bind(operationId, String(callback.from.id)).first<{kind:string;source_key:string|null}>();
    const result = await env.DB.prepare(
      "UPDATE secretary_operations SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND actor_id=? AND status='running'",
    ).bind(operationId, String(callback.from.id)).run();
    const cancelled = (result.meta?.changes ?? 0) > 0;
    if (cancelled && operation?.kind === "photo_upload" && operation.source_key) {
      const [chatId, threadId, uploaderId, albumId] = operation.source_key.split("|");
      if (chatId && threadId && uploaderId && albumId) {
        await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id=? AND thread_id=? AND uploader_id=? AND media_group_id=?")
          .bind(chatId, Number(threadId), uploaderId, albumId).run();
        await env.DB.prepare("DELETE FROM secretary_photo_album_status WHERE chat_id=? AND thread_id=? AND uploader_id=? AND media_group_id=?")
          .bind(chatId, Number(threadId), uploaderId, albumId).run();
      }
    }
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: cancelled ? "Отмена запрошена." : "Операция уже завершена или недоступна.",
      show_alert: false,
    });
    if (callback.message && cancelled) {
      try {
        await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
          chat_id: callback.message.chat.id, message_id: callback.message.message_id,
          text: operation?.kind === "photo_upload" ? "⏹ Загрузка отменена. Незавершённый альбом очищен." : "⏹ Отмена запрошена. Останавливаю процесс…",
          reply_markup: { inline_keyboard: [] },
        });
      } catch (error) { console.warn("Unable to update cancellation status message", compositeErrorText(error)); }
    }
    return;
  }
  if (data === "photo:create") {
    const msg = callback.message;
    if (!msg || msg.chat.type !== "supergroup" || !msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Кнопка работает только в теме «MODEL BANK».", show_alert: true });
      return;
    }
    const topic = await env.DB.prepare("SELECT chat_id, thread_id FROM secretary_photo_topics WHERE id = 1")
      .first<{ chat_id: string; thread_id: number }>();
    if (!topic || topic.chat_id !== String(msg.chat.id) || topic.thread_id !== msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Это не зарегистрированная тема MODEL BANK.", show_alert: true });
      return;
    }
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Готово. Можно загружать фото." });
    await telegram(env.SECRETARY_BOT_TOKEN, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
      text: "Начните новую фотоанкету: отправьте первое фото с подписью «Имя Фамилия», затем ещё три фото подряд (или одним альбомом из четырёх).",
    });
    return;
  }
  if (data === "photo_replace:yes" || data === "photo_replace:no") {
    const msg = callback.message;
    if (!msg || msg.chat.type !== "supergroup" || !msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось определить тему.", show_alert: true });
      return;
    }
    const pendingPhotoSet = await env.DB.prepare(
      "SELECT model_id, photos_json FROM secretary_photo_replacement_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ?",
    ).bind(String(msg.chat.id), msg.message_thread_id, String(callback.from.id)).first<{model_id:string;photos_json:string}>();
    if (!pendingPhotoSet) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Запрос уже обработан или истёк.", show_alert: true });
      return;
    }
    if (data === "photo_replace:yes") {
      const newPhotos = JSON.parse(pendingPhotoSet.photos_json) as Array<{file_id:string;file_unique_id:string}>;
      if (newPhotos.length !== 4) {
        await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось прочитать новый комплект.", show_alert: true });
        return;
      }
      await saveSecretaryPhotoSet(env, pendingPhotoSet.model_id, newPhotos, String(callback.from.id), msg.chat.id, msg.message_thread_id);
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Фотографии заменены." });
      try {
        await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
      } catch (error) {
        console.error("Failed to delete photo replacement prompt", error);
      }
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
        text: "✅ Новые фотографии успешно сохранены.",
        reply_markup: { inline_keyboard: [[{ text: "➕ Создать фотоанкету", callback_data: "photo:create" }]] },
      });
    } else {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Оставили прежние фотографии." });
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "Хорошо, прежние фотографии оставлены без изменений." });
    }
    await env.DB.prepare("DELETE FROM secretary_photo_replacement_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ?")
      .bind(String(msg.chat.id), msg.message_thread_id, String(callback.from.id)).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
    return;
  }
  if (data === "composite:create") {
    const msg = callback.message;
    if (!msg || msg.chat.type !== "supergroup" || !msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callback.id, text: "Кнопка работает только в теме «КОМПОЗИТКИ».", show_alert: true,
      });
      return;
    }
    const topic = await env.DB.prepare("SELECT chat_id, thread_id FROM secretary_composite_topics WHERE id = 1")
      .first<{ chat_id: string; thread_id: number }>();
    if (!topic || topic.chat_id !== String(msg.chat.id) || topic.thread_id !== msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callback.id, text: "Это не зарегистрированная тема композиток.", show_alert: true,
      });
      return;
    }
    await env.DB.prepare(
      "INSERT INTO secretary_composite_input_pending(chat_id, thread_id, user_id) VALUES(?,?,?) ON CONFLICT(chat_id,thread_id,user_id) DO UPDATE SET created_at=CURRENT_TIMESTAMP",
    ).bind(String(msg.chat.id), msg.message_thread_id, String(callback.from.id)).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Готово. Жду список моделей." });
    await telegram(env.SECRETARY_BOT_TOKEN, "editMessageReplyMarkup", {
      chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] },
    });
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
      text: "Отправьте от 1 до 20 фамилий или ФИО — по одной модели на строку.",
    });
    return;
  }
  const match = data.match(/^(csel|comp):([a-zA-Z0-9_-]{1,50})$/);
  if (!match || !callback.message) {
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось выбрать модель." });
    return;
  }
  if (match[1] === "comp" && callback.message.chat.type === "private") {
    const model = await env.DB.prepare(
      `SELECT m.id, m.first_name, m.last_name,
        p.height_cm, p.bust_cm, p.waist_cm, p.hips_cm,
        p.clothing_size, p.shoe_size, p.hair_color, p.eye_color
       FROM models m LEFT JOIN model_profiles p ON p.model_id = m.id
       WHERE m.id = ? AND m.is_active = 1 AND m.lifecycle_status = 'active'`,
    ).bind(match[2]).first<SecretaryModelRow>();
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id, text: model ? "Модель выбрана." : "Анкета не найдена.",
    });
    if (model) await sendSecretaryCompositeSources(env, callback.message.chat.id, model);
    return;
  }
  if (match[1] !== "csel" || callback.message.chat.type !== "supergroup" || !callback.message.message_thread_id) {
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось выбрать модель." });
    return;
  }
  const pending = await env.DB.prepare(
    "SELECT surname FROM secretary_composite_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ? AND created_at >= datetime('now', '-15 minutes')",
  ).bind(String(callback.message.chat.id), callback.message.message_thread_id, String(callback.from.id)).first<{surname:string}>();
  if (!pending) {
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Время выбора истекло. Повторите /comp Фамилия.", show_alert: true });
    return;
  }
  const model = await env.DB.prepare(
    `SELECT m.id, m.first_name, m.last_name,
      p.height_cm, p.bust_cm, p.waist_cm, p.hips_cm,
      p.clothing_size, p.shoe_size, p.hair_color, p.eye_color
     FROM models m LEFT JOIN model_profiles p ON p.model_id = m.id
     WHERE m.id = ? AND m.is_active = 1 AND m.lifecycle_status = 'active'`,
  ).bind(match[2]).first<SecretaryModelRow>();
  if (!model || normalizeName(model.last_name) !== normalizeName(pending.surname)) {
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Эта модель больше недоступна.", show_alert: true });
    return;
  }
  await env.DB.prepare("DELETE FROM secretary_composite_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ?")
    .bind(String(callback.message.chat.id), callback.message.message_thread_id, String(callback.from.id)).run();
  await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", {
    callback_query_id: callback.id, text: "Выбрана: " + model.first_name,
  });
  await telegram(env.SECRETARY_BOT_TOKEN, "editMessageReplyMarkup", {
    chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] },
  });
  await generateCompositeInTopic(env, callback.message, model.first_name + " " + model.last_name);
}

const DELEGATED_ADMIN_TELEGRAM_IDS = new Set(["727737302"]);
function hasDirectorAccess(env: Env, telegramId: string): boolean {
  return telegramId === env.OWNER_TELEGRAM_ID || telegramId === env.DIRECTOR_TELEGRAM_ID || DELEGATED_ADMIN_TELEGRAM_IDS.has(telegramId);
}
interface MiniAppActor { id: string; first_name?: string; last_name?: string; username?: string; }
function bytesToHex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2,"0")).join(""); }
async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}
type MiniAppAuthResult = { actor: MiniAppActor | null; reason: string };
async function validateMiniAppInitData(initData: string, botToken: string): Promise<MiniAppAuthResult> {
  if (!initData) return { actor: null, reason: "empty_init_data" };
  if (initData.length > 8192) return { actor: null, reason: "init_data_too_long" };
  if (!botToken) return { actor: null, reason: "director_bot_token_missing" };
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash");
  const authDateRaw = params.get("auth_date");
  const userRaw = params.get("user");
  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash)) return { actor: null, reason: "hash_missing_or_invalid" };
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) return { actor: null, reason: "auth_date_missing_or_invalid" };
  const authDate = Number(authDateRaw), ageSeconds = Math.floor(Date.now()/1000-authDate);
  if (!Number.isFinite(authDate)) return { actor: null, reason: "auth_date_invalid" };
  if (ageSeconds > 86400) return { actor: null, reason: "auth_data_expired" };
  if (ageSeconds < -300) return { actor: null, reason: "auth_date_in_future" };
  if (!userRaw) return { actor: null, reason: "user_missing" };
  params.delete("hash");
  const check = [...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+"="+v).join("\n");
  try {
    const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
    const actual = bytesToHex(await hmacSha256(secret, check));
    let diff=0; for(let i=0;i<actual.length;i++) diff |= actual.charCodeAt(i)^suppliedHash.toLowerCase().charCodeAt(i);
    if(diff!==0) return { actor: null, reason: "signature_mismatch" };
    try {
      const user=JSON.parse(userRaw) as MiniAppActor;
      return Number.isSafeInteger(Number(user.id))?{ actor: {...user,id:String(user.id)}, reason: "ok" }:{ actor: null, reason: "user_id_invalid" };
    } catch { return { actor: null, reason: "user_json_invalid" }; }
  } catch {
    return { actor: null, reason: "signature_check_failed" };
  }
}
async function miniAppActor(request: Request, env: Env): Promise<MiniAppAuthResult> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^tma (.*)$/s);
  if (!match) return { actor: null, reason: "authorization_header_missing_or_invalid" };
  return validateMiniAppInitData(match[1], env.DIRECTOR_BOT_TOKEN);
}
async function actorHasPermission(env: Env, actorId: string, _permission: string): Promise<boolean> {
  return hasDirectorAccess(env, actorId);
}
function appHtml(): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>InterModels</title><script src="https://telegram.org/js/telegram-web-app.js"></script><style>
*{box-sizing:border-box}:root{--im-bg:#0f1115;--im-surface:#1a1d24;--im-surface2:#22262f;--im-border:rgba(255,255,255,.07);--im-text:#f3f4f6;--im-muted:#9ca3af;--im-faint:#6b7280;--im-accent:#34d399}
[data-theme="ruby"]{--im-accent:#f43f5e}[data-theme="sapphire"]{--im-accent:#38bdf8}[data-theme="amethyst"]{--im-accent:#a78bfa}[data-theme="topaz"]{--im-accent:#fbbf24}
body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;padding:0 0 88px;background:var(--im-bg);color:var(--im-text);min-height:100vh}
h1{font-size:20px;margin:0;font-weight:650;letter-spacing:-.3px}h1 span{color:var(--im-accent)}h2{font-size:16px;margin:0 0 12px;font-weight:600}.muted{color:var(--im-muted);font-size:13px;opacity:1}
.im-header{padding:20px 18px 12px;display:flex;align-items:center;justify-content:space-between}.im-theme-btn{width:38px;height:38px;border-radius:50%;border:1px solid var(--im-border);background:var(--im-surface);color:var(--im-text);font-size:17px}
.im-greeting{padding:4px 18px 16px}.im-greeting strong{font-size:18px;font-weight:550;display:block;margin-bottom:4px}.im-role{color:var(--im-muted);font-size:12px;display:flex;align-items:center;gap:7px}.im-dot{width:6px;height:6px;border-radius:50%;background:var(--im-accent)}
.im-metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 14px 20px}.im-metric{background:var(--im-surface);border:1px solid var(--im-border);border-radius:15px;padding:14px;min-width:0}.im-metric-icon{font-size:17px;margin-bottom:9px}.im-metric-value{font-size:27px;font-weight:650;color:var(--im-accent);letter-spacing:-.5px}.im-metric-label{font-size:12px;font-weight:550;margin-top:2px}.im-metric-sub{font-size:10px;color:var(--im-faint);margin-top:3px}
.im-section{padding:0 14px;margin-bottom:18px}.im-section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.im-link{font-size:12px;color:var(--im-accent);text-decoration:none}
.im-event-list{background:var(--im-surface);border:1px solid var(--im-border);border-radius:15px;padding:0 13px}.im-event{display:flex;align-items:center;gap:11px;padding:12px 0;border-bottom:1px solid var(--im-border)}.im-event:last-child{border:0}.im-event-icon{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:var(--im-surface2);font-size:15px}.im-event-info{flex:1;min-width:0}.im-event-name{font-size:13px;font-weight:550}.im-event-action{font-size:11px;color:var(--im-muted);margin-top:2px}.im-event-time{font-size:10px;color:var(--im-faint);white-space:nowrap}
.im-bottom-nav{position:fixed;bottom:0;left:0;right:0;z-index:50;background:rgba(15,17,21,.94);backdrop-filter:blur(14px);border-top:1px solid var(--im-border);display:flex;justify-content:space-around;padding:9px 2px max(18px,env(safe-area-inset-bottom))}.im-bottom-nav a{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:10px;color:var(--im-faint);text-decoration:none;min-width:52px}.im-bottom-nav a.active{color:var(--im-accent)}.im-bottom-nav .nav-icon{font-size:19px}
 .im-page{display:none;min-height:calc(100vh - 82px);padding-bottom:12px}.im-page.active{display:block}.im-page>.panel{margin-top:0}.im-page-title{padding:18px 18px 12px;font-size:19px;font-weight:650;letter-spacing:-.3px}.im-page-title span{color:var(--im-accent)}.im-theme-panel{display:none;position:fixed;inset:0;z-index:100;background:#0009;align-items:flex-end;justify-content:center}.im-theme-panel.active{display:flex}.im-theme-content{width:100%;max-width:440px;background:var(--im-surface);border-radius:20px 20px 0 0;padding:20px 18px max(30px,env(safe-area-inset-bottom))}.im-theme-title{text-align:center;font-size:15px;font-weight:600;margin-bottom:18px}.im-theme-options{display:flex;justify-content:center;gap:13px}.im-theme-circle{width:40px;height:40px;border-radius:50%;border:3px solid transparent;cursor:pointer;padding:0}.im-theme-circle.active{border-color:white;transform:scale(1.08)}.im-theme-circle[data-theme="emerald"]{background:#34d399}.im-theme-circle[data-theme="ruby"]{background:#f43f5e}.im-theme-circle[data-theme="sapphire"]{background:#38bdf8}.im-theme-circle[data-theme="amethyst"]{background:#a78bfa}.im-theme-circle[data-theme="topaz"]{background:#fbbf24}
.panel{background:var(--im-surface);border:1px solid var(--im-border);color:var(--im-text);padding:15px;border-radius:15px;margin:0 14px 14px;scroll-margin-top:12px}
input,select,button{box-sizing:border-box;width:100%;padding:11px;margin:5px 0;border-radius:9px;border:1px solid var(--im-border);background:var(--im-surface2);color:var(--im-text)}input::placeholder{color:var(--im-faint)}button{background:var(--im-accent);color:#101318;border:0;font-weight:650}button.secondary{background:transparent;color:var(--im-text);border:1px solid var(--im-border)}
.person{display:flex;gap:10px;align-items:center;padding:11px 0;border-bottom:1px solid var(--im-border)}.person:last-child{border:0}.person.frozen{opacity:.52;filter:grayscale(1)}.person input{width:20px;height:20px;margin:0;flex:none}.person .meta{flex:1;min-width:0}.status{color:#38bdf8;font-size:12px;font-weight:700}.active{color:var(--im-accent)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.grid label{font-size:12px}.grid input{margin-top:4px}.toolbar{display:flex;gap:8px}.toolbar button{flex:1}.stats{font-size:13px;line-height:1.8;color:var(--im-muted)}.perm{display:block;margin:8px 0}.perm input{width:auto}.person button{width:auto}
</style></head><body>
  <header class="im-header" id="dashboardHome"><h1>Inter<span>Models</span></h1><button id="themeToggle" class="im-theme-btn" type="button" aria-label="Выбрать тему">🎨</button></header>
  <div class="im-greeting"><strong id="directorGreeting">Добро пожаловать</strong><div class="im-role"><i class="im-dot"></i>Director · InterModels</div></div>
  <div id="status" class="muted" style="position:sticky;top:0;z-index:20;padding:9px 14px;margin:0 14px 12px;background:var(--im-surface);border:1px solid var(--im-border);border-radius:10px"></div>
  <section class="im-metrics"><div class="im-metric"><div class="im-metric-icon">👥</div><div class="im-metric-value" id="metricTotal">—</div><div class="im-metric-label">Всего моделей</div><div class="im-metric-sub">В базе агентства</div></div><div class="im-metric"><div class="im-metric-icon">✓</div><div class="im-metric-value" id="metricApproved">—</div><div class="im-metric-label">Активные</div><div class="im-metric-sub">Профили доступны</div></div><div class="im-metric"><div class="im-metric-icon">⏳</div><div class="im-metric-value" id="metricPending">—</div><div class="im-metric-label">Ожидают одобрения</div><div class="im-metric-sub">Заявки на привязку</div></div><div class="im-metric"><div class="im-metric-icon">❄️</div><div class="im-metric-value" id="metricFrozen">—</div><div class="im-metric-label">Замороженные</div><div class="im-metric-sub">Временно неактивны</div></div></section>
  <section class="im-section"><div class="im-section-head"><h2>Последние события</h2><a class="im-link" href="#modelsPanel">К базе моделей ↓</a></div><div class="im-event-list" id="recentEvents"><div class="im-event"><div class="im-event-info muted">Загрузка событий…</div></div></div></section>
  <div class="im-theme-panel" id="themePanel"><div class="im-theme-content"><div class="im-theme-title">Выберите тему</div><div class="im-theme-options"><button type="button" class="im-theme-circle active" data-theme="emerald" aria-label="Изумрудная"></button><button type="button" class="im-theme-circle" data-theme="ruby" aria-label="Рубиновая"></button><button type="button" class="im-theme-circle" data-theme="sapphire" aria-label="Сапфировая"></button><button type="button" class="im-theme-circle" data-theme="amethyst" aria-label="Аметистовая"></button><button type="button" class="im-theme-circle" data-theme="topaz" aria-label="Топазовая"></button></div></div></div>
  <section class="panel" id="tasksPanel"><h2>Ежемесячное обновление</h2><div id="refreshStats" class="stats">Загрузка статистики…</div>
  <div class="muted">После завершения кампании кнопка запуска композиток появится в итоговом сообщении со статистикой.</div></section>
  <section class="panel" id="compositesPanel"><h2>Задания композиток</h2><h3>Последние задания генерации</h3><button id="reloadCompositeJobs" class="secondary">Обновить статус</button><div id="compositeJobs" class="stats">Загрузка заданий…</div></section>
  <section class="panel" id="modelsPanel"><h2>База моделей</h2><input id="search" placeholder="Поиск по имени или фамилии">
  <select id="filter"><option value="all">Все модели</option><option value="active">Активные</option><option value="frozen">Замороженные</option></select>
  <div id="models">Загрузка…</div></section>
  <section class="panel" id="schedulePanel"><h2>Расписание обновления</h2><div class="muted">Кампания запускается ежемесячно в выбранный день. Срок для моделей — 48 часов. Расписание применяется к следующим кампаниям.</div>
  <div class="grid"><label>День месяца<input id="cycleDay" type="number" min="1" max="28" value="1"></label><label>Часовой пояс<input id="timezone" value="UTC" placeholder="Europe/Amsterdam"></label>
  <label>День 1 · утро<input id="time1" type="time" value="09:00"></label><label>День 1 · вечер<input id="time2" type="time" value="20:00"></label>
  <label>День 2 · утро<input id="time3" type="time" value="09:00"></label><label>День 2 · вечер<input id="time4" type="time" value="20:00"></label></div>
  <button id="saveSettings">Сохранить расписание</button></section>
  <nav class="im-bottom-nav" aria-label="Основная навигация"><a href="#home" data-page="home" class="active"><span class="nav-icon">⌂</span>Главная</a><a href="#models" data-page="models"><span class="nav-icon">👥</span>Модели</a><a href="#composites" data-page="composites"><span class="nav-icon">▦</span>Композитки</a><a href="#tasks" data-page="tasks"><span class="nav-icon">☑</span>Задания</a></nav>
  <script>
  const st=document.getElementById('status');let models=[];const themes=['emerald','ruby','sapphire','amethyst','topaz'];let themeUser='anonymous';const themePanel=document.getElementById('themePanel');
  // Build real, mutually exclusive app screens; keep existing feature DOM and handlers intact.
  const pageHost=document.createElement('main');pageHost.id='imPageHost';
  const nav=document.querySelector('.im-bottom-nav');
  nav.before(pageHost);
  const pageNodes={
    home:['#dashboardHome','.im-greeting','#status','.im-metrics','.im-section'],
    models:['#modelsPanel'],
    composites:['#compositesPanel'],
    tasks:['#tasksPanel','#schedulePanel']
  };
  const pageTitles={models:'Модели',composites:'Композитки',tasks:'Задания'};
  for(const [key,selectors] of Object.entries(pageNodes)){
    const page=document.createElement('section');page.className='im-page'+(key==='home'?' active':'');page.dataset.screen=key;
    if(pageTitles[key]){const title=document.createElement('div');title.className='im-page-title';title.textContent=pageTitles[key];page.append(title)}
    for(const selector of selectors){const node=document.querySelector(selector);if(node)page.append(node)}
    pageHost.append(page);
  }
  function showPage(key,updateHash=true){
    if(!Object.prototype.hasOwnProperty.call(pageNodes,key))key='home';
    document.querySelectorAll('.im-page').forEach(page=>page.classList.toggle('active',page.dataset.screen===key));
    document.querySelectorAll('.im-bottom-nav a').forEach(link=>link.classList.toggle('active',link.dataset.page===key));
    if(updateHash&&location.hash!=='#'+key)history.replaceState(null,'','#'+key);
    window.scrollTo({top:0,behavior:'instant'});
  }
  nav.addEventListener('click',event=>{const link=event.target.closest('a[data-page]');if(!link)return;event.preventDefault();showPage(link.dataset.page)});
  document.querySelector('.im-link')?.addEventListener('click',event=>{event.preventDefault();showPage('models')});
  window.addEventListener('hashchange',()=>{const key=location.hash.slice(1);if(pageNodes[key])showPage(key,false)});
  if(pageNodes[location.hash.slice(1)])showPage(location.hash.slice(1),false);

  function applyTheme(theme){if(!themes.includes(theme))theme='emerald';if(theme==='emerald')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',theme);document.querySelectorAll('.im-theme-circle').forEach(el=>el.classList.toggle('active',el.dataset.theme===theme));try{localStorage.setItem('intermodels-theme-'+themeUser,theme)}catch{}}
  document.getElementById('themeToggle').onclick=()=>themePanel.classList.add('active');themePanel.onclick=e=>{if(e.target===themePanel)themePanel.classList.remove('active')};document.querySelectorAll('.im-theme-circle').forEach(el=>el.onclick=()=>{applyTheme(el.dataset.theme);themePanel.classList.remove('active')});
  function initTheme(){const user=window.Telegram?.WebApp?.initDataUnsafe?.user;themeUser=user?.id?String(user.id):'anonymous';let saved='emerald';try{saved=localStorage.getItem('intermodels-theme-'+themeUser)||'emerald'}catch{}applyTheme(saved);if(user){const full=[user.first_name,user.last_name].filter(Boolean).join(' ');document.getElementById('directorGreeting').textContent=full?'Добро пожаловать, '+full:'Добро пожаловать'}}
  let tg=window.Telegram?.WebApp;
  async function initTelegramWebApp(){
    if(!tg){
      await new Promise(resolve=>{
        const script=document.createElement('script');
        script.src='https://telegram.org/js/telegram-web-app.js';
        script.async=true;
        script.onload=resolve;
        script.onerror=resolve;
        document.head.appendChild(script);
      });
      tg=window.Telegram?.WebApp;
    }
    if(tg){tg.ready();tg.expand();}
    return tg;
  }
  const telegramReady=initTelegramWebApp();
  const getInitData=()=>window.Telegram?.WebApp?.initData||tg?.initData||'';
  function telegramLaunchDiagnostic(){
    const params=new URLSearchParams(location.hash.replace(/^#/,''));
    return 'SDK: '+(window.Telegram?.WebApp?'есть':'нет')+
      ' · initData: '+(getInitData()?'есть':'нет')+
      ' · launch-параметр: '+(params.has('tgWebAppData')?'есть':'нет')+
      ' · платформа: '+(window.Telegram?.WebApp?.platform||'не определена')+
      ' · версия: '+(window.Telegram?.WebApp?.version||'не определена');
  }
  window.addEventListener('error',e=>{st.textContent='Ошибка интерфейса: '+(e.message||'неизвестная ошибка')});window.addEventListener('unhandledrejection',e=>{st.textContent='Ошибка запроса: '+(e.reason?.message||String(e.reason||'неизвестная ошибка'))});
  async function api(m,p,b){await telegramReady;await new Promise(resolve=>setTimeout(resolve,250));const initData=getInitData();if(!initData){st.textContent='Telegram initData отсутствует. '+telegramLaunchDiagnostic()+'. Откройте приложение через кнопку «Открыть Mini App» в личном чате @InterModels_director_bot.';throw Error('Telegram initData отсутствует')}const r=await fetch(p,{method:m,headers:{Authorization:'tma '+initData,'Content-Type':'application/json'},...(b?{body:JSON.stringify(b)}:{})});const d=await r.json();if(!r.ok){if(r.status===401&&d.diagnostic_code)st.textContent='Диагностика авторизации: '+d.diagnostic_code;throw Error((d.error||'Ошибка')+(d.diagnostic_code?' ['+d.diagnostic_code+']':''))}return d}
  function renderModels(){const root=document.getElementById('models');root.innerHTML='';const q=document.getElementById('search').value.trim().toLocaleLowerCase('ru');const filter=document.getElementById('filter').value;const visible=models.filter(m=>(m.first_name+' '+m.last_name).toLocaleLowerCase('ru').includes(q)&&(filter==='all'||m.lifecycle_status===filter));if(!visible.length){root.textContent='Модели не найдены.';return}
  for(const m of visible){const row=document.createElement('div');row.className='person'+(m.lifecycle_status==='frozen'?' frozen':'');const meta=document.createElement('div');meta.className='meta';const name=document.createElement('strong');name.textContent=m.first_name+' '+m.last_name;const line=document.createElement('div');line.className=m.lifecycle_status==='frozen'?'status':'muted';line.textContent=m.lifecycle_status==='frozen'?'Заморожена/Заморожен':'Активна анкета';meta.append(name,line);row.append(meta);root.append(row)}}
  async function loadModels(){try{const d=await api('GET','/api/director/models');models=d.models;renderModels();renderDashboardMetrics()}catch(e){document.getElementById('models').textContent=e.message}}
  async function loadStats(){try{const d=await api('GET','/api/director/refresh-status');const c=d.campaign;if(!c){document.getElementById('refreshStats').textContent='Кампания ещё не запускалась.';return}document.getElementById('refreshStats').textContent='Моделей: '+c.total+' · Обновлено: '+c.updated+' · Ожидают: '+c.pending+' · Заморожено: '+c.frozen+' · Comp опубликовано: '+c.published+' · Ошибок: '+c.failed}catch(e){document.getElementById('refreshStats').textContent=e.message}}
  function renderDashboardMetrics(){document.getElementById('metricTotal').textContent=models.length;document.getElementById('metricApproved').textContent=models.filter(m=>m.lifecycle_status==='active').length;document.getElementById('metricFrozen').textContent=models.filter(m=>m.lifecycle_status==='frozen').length}
  async function loadDashboard(){try{const d=await api('GET','/api/director/dashboard');document.getElementById('metricPending').textContent=d.pending_requests;const root=document.getElementById('recentEvents');root.innerHTML='';if(!d.events.length){root.textContent='Пока нет зарегистрированных событий.';return}for(const ev of d.events){const row=document.createElement('div');row.className='im-event';const ico=document.createElement('div');ico.className='im-event-icon';ico.textContent=ev.icon||'•';const info=document.createElement('div');info.className='im-event-info';const name=document.createElement('div');name.className='im-event-name';name.textContent=ev.model_name||'InterModels';const action=document.createElement('div');action.className='im-event-action';action.textContent=ev.label;const time=document.createElement('div');time.className='im-event-time';time.textContent=formatJobTime(ev.created_at);info.append(name,action);row.append(ico,info,time);root.append(row)}}catch(e){document.getElementById('recentEvents').textContent='Не удалось загрузить события: '+e.message}}
  function formatJobTime(value){if(!value)return 'время неизвестно';const raw=String(value);const date=new Date(raw.includes('T')?(raw.endsWith('Z')||/[+-]\\d\\d:\\d\\d$/.test(raw)?raw:raw+'Z'):raw.replace(' ','T')+'Z');if(Number.isNaN(date.getTime()))return raw;return new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Yekaterinburg',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date)+' (UTC+5)'}
  async function loadCompositeJobs(){const root=document.getElementById('compositeJobs');st.textContent='Обновляю статус композиток…';try{const d=await api('GET','/api/director/composites');root.innerHTML='';if(!d.jobs.length){root.textContent='Заданий пока нет.';st.textContent='Статус обновлён.';return}for(const j of d.jobs){const item=document.createElement('div');item.className='person';const title=document.createElement('strong');title.textContent=(j.first_name||'Модель')+' '+(j.last_name||'')+' · '+({pending:'В очереди',processing:'Генерируется',published:'Опубликована',failed:'Ошибка'}[j.status]||j.status);const info=document.createElement('div');info.className='muted';info.textContent='Попыток: '+j.attempts+' · '+formatJobTime(j.updated_at)+(j.last_error?(j.status==='failed'?' · Причина: ':' · Этап: ')+j.last_error:'');item.append(title,info);if(j.status==='failed'){const retry=document.createElement('button');retry.className='secondary';retry.textContent='Повторить только эту композитку';retry.onclick=async()=>{retry.disabled=true;try{await api('POST','/api/director/composites',{retry_model_id:j.model_id});st.textContent='Задание Владислава Демакова возвращено в очередь.';await loadCompositeJobs()}catch(e){retry.disabled=false;st.textContent=e.message}};item.append(retry)}root.append(item)}st.textContent='Статус композиток обновлён.'}catch(e){root.textContent='Не удалось получить статус: '+e.message;st.textContent='Ошибка обновления статуса: '+e.message}}
  document.getElementById('reloadCompositeJobs').onclick=loadCompositeJobs;
  document.getElementById('search').oninput=renderModels;document.getElementById('filter').onchange=renderModels;
  document.getElementById('saveSettings').onclick=async()=>{try{const body={cycle_day:Number(document.getElementById('cycleDay').value),timezone:document.getElementById('timezone').value.trim(),reminder_times:[1,2,3,4].map(i=>document.getElementById('time'+i).value)};await api('PUT','/api/director/refresh-settings',body);st.textContent='Расписание сохранено.'}catch(e){st.textContent=e.message}};
  async function loadSettings(){try{const d=await api('GET','/api/director/refresh-settings');const x=d.settings;document.getElementById('cycleDay').value=x.cycle_day;document.getElementById('timezone').value=x.timezone;x.reminder_times.forEach((v,i)=>document.getElementById('time'+(i+1)).value=v)}catch(e){st.textContent=e.message}}
  initTheme();loadModels();loadStats();loadSettings();loadCompositeJobs();loadDashboard();
  </script></body></html>`;
  return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'self' https://telegram.org; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org"}});
}
async function handleDirectorApi(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await miniAppActor(request, env);
  if (!auth.actor) {
    console.warn("Mini App authentication rejected", {
      reason: auth.reason,
      authorizationHeaderPresent: request.headers.has("Authorization"),
      userAgent: (request.headers.get("User-Agent") ?? "").slice(0, 160),
    });
    return json({
      error: "Недействительная или устаревшая авторизация Telegram.",
      diagnostic_code: auth.reason,
    }, 401);
  }
  const actor = auth.actor;
  const path = url.pathname;
  const isAdmin = hasDirectorAccess(env, actor.id);
  if (path === "/api/director/dashboard") {
    if (!(await actorHasPermission(env, actor.id, "profile.view"))) return json({ error: "Недостаточно прав." }, 403);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM registration_requests WHERE status='pending'").first<{count:number}>();
    const rows = await env.DB.prepare(`SELECT a.action,a.created_at,m.first_name,m.last_name FROM agency_audit_log a LEFT JOIN models m ON m.id=a.model_id ORDER BY a.created_at DESC LIMIT 8`).all<{action:string;created_at:string;first_name:string|null;last_name:string|null}>();
    const labels: Record<string,{label:string;icon:string}> = {"profile.refresh":{label:"Обновлены параметры модели",icon:"📏"},"profile.update":{label:"Анкета обновлена",icon:"✏️"},"photos.upload":{label:"Загружены новые фотографии",icon:"📷"},"photos.delete":{label:"Удалены фотографии",icon:"🗑️"},"composite.generate":{label:"Запущена генерация композитки",icon:"🖼️"},"composite.publish":{label:"Композитка опубликована",icon:"✓"},"registration.approve":{label:"Заявка одобрена",icon:"✓"},"registration.reject":{label:"Заявка отклонена",icon:"×"},"refresh.settings.update":{label:"Изменено расписание обновления",icon:"⚙️"},"staff.grant":{label:"Выдан доступ сотруднику",icon:"🔑"},"staff.revoke":{label:"Отозван доступ сотрудника",icon:"🔒"}};
    const events=(rows.results??[]).map(row=>({...row,model_name:[row.first_name,row.last_name].filter(Boolean).join(" ")||null,...(labels[row.action]??{label:row.action.replace(/[._]/g," "),icon:"•"})}));
    return json({ok:true,pending_requests:pending?.count??0,events});
  }
  if (path === "/api/director/models") {
    if (!(await actorHasPermission(env, actor.id, "profile.view"))) return json({ error: "Недостаточно прав." }, 403);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const result = await env.DB.prepare(
      `SELECT m.id,m.first_name,m.last_name,m.lifecycle_status,
        p.height_cm,p.weight_kg,p.bust_cm,p.waist_cm,p.hips_cm,p.clothing_size,p.shoe_size,p.hair_color,p.eye_color
       FROM models m LEFT JOIN model_profiles p ON p.model_id=m.id
       WHERE m.is_active=1 ORDER BY m.last_name,m.first_name`,
    ).all<Record<string, unknown>>();
    return json({ ok: true, models: result.results ?? [] });
  }
  if (path === "/api/director/refresh-status") {
    if (!(await actorHasPermission(env, actor.id, "profile.view"))) return json({ error: "Недостаточно прав." }, 403);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const campaign = await env.DB.prepare(
      "SELECT id,cycle_key,starts_at,deadline_at,status FROM profile_refresh_campaigns WHERE cycle_key NOT LIKE 'manual:%' ORDER BY starts_at DESC LIMIT 1",
    ).first<{ id: string; cycle_key: string; starts_at: string; deadline_at: string; status: string }>();
    if (!campaign) return json({ ok: true, campaign: null });
    const members = await env.DB.prepare(
      "SELECT COUNT(*) AS total,SUM(CASE WHEN status='updated' THEN 1 ELSE 0 END) AS updated,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='frozen' THEN 1 ELSE 0 END) AS frozen FROM profile_refresh_members WHERE campaign_id=?",
    ).bind(campaign.id).first<{ total: number; updated: number | null; pending: number | null; frozen: number | null }>();
    const jobs = await env.DB.prepare(
      "SELECT SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS queued FROM composite_refresh_jobs WHERE campaign_id=?",
    ).bind(campaign.id).first<{ published: number | null; failed: number | null; queued: number | null }>();
    return json({ ok: true, campaign: {
      ...campaign, total: members?.total ?? 0, updated: members?.updated ?? 0,
      pending: members?.pending ?? 0, frozen: members?.frozen ?? 0,
      published: jobs?.published ?? 0, failed: jobs?.failed ?? 0, queued: jobs?.queued ?? 0,
    } });
  }
  if (path === "/api/director/refresh-settings") {
    if (!isAdmin) return json({ error: "Настраивать расписание может только директор." }, 403);
    if (request.method === "GET") {
      const settings = await env.DB.prepare("SELECT cycle_day,timezone,campaign_start_time,reminder_times_json FROM director_refresh_settings WHERE id=1")
        .first<{ cycle_day: number; timezone: string; campaign_start_time: string; reminder_times_json: string }>();
      let reminder_times: string[] = ["09:00","20:00","09:00","20:00"];
      try { if (settings) reminder_times = JSON.parse(settings.reminder_times_json); } catch {}
      return json({ ok: true, settings: { cycle_day: settings?.cycle_day ?? 1, timezone: settings?.timezone ?? "UTC", campaign_start_time: settings?.campaign_start_time ?? "09:00", reminder_times } });
    }
    if (request.method === "PUT") {
      let body: any; try { body = await request.json(); } catch { return json({ error: "Некорректный JSON." }, 400); }
      const cycleDay = Number(body?.cycle_day), timezone = String(body?.timezone ?? "").trim();
      const times = body?.reminder_times;
      if (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 28 ||
          !Array.isArray(times) || times.length !== 4 ||
          times.some((time: unknown) => typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) ||
          !timezone || timezone.length > 80) return json({ error: "Проверьте день месяца, часовой пояс и четыре времени уведомлений." }, 400);
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date()); }
      catch { return json({ error: "Неизвестный часовой пояс. Используйте формат Europe/Amsterdam." }, 400); }
      await env.DB.prepare(
        `UPDATE director_refresh_settings SET cycle_day=?,timezone=?,campaign_start_time=?,reminder_times_json=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`,
      ).bind(cycleDay, timezone, times[0], JSON.stringify(times), actor.id).run();
      await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'refresh.settings.update', ?)")
        .bind(randomId(), actor.id, JSON.stringify({ cycle_day: cycleDay, timezone, reminder_times: times })).run();
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  }
  if (path === "/api/director/composites") {
    if (!(await actorHasPermission(env, actor.id, "composite.generate"))) return json({ error: "Недостаточно прав." }, 403);
    if (request.method === "GET") {
      const jobs = await env.DB.prepare(
        `SELECT j.campaign_id,j.model_id,j.status,j.attempts,j.last_error,j.updated_at,
          m.first_name,m.last_name
         FROM composite_refresh_jobs j
         LEFT JOIN models m ON m.id=j.model_id
         ORDER BY j.created_at DESC LIMIT 100`,
      ).all<{campaign_id:string;model_id:string;status:string;attempts:number;last_error:string|null;updated_at:string;first_name:string|null;last_name:string|null}>();
      return json({ok:true,jobs:jobs.results ?? []});
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body: any; try { body = await request.json(); } catch { return json({ error: "Некорректный JSON." }, 400); }
    // Retry only an existing failed job for one model; never enqueue a published or active job.
    if (body?.retry_model_id !== undefined) {
      const modelId = String(body.retry_model_id);
      if (!/^[a-zA-Z0-9_-]{1,50}$/.test(modelId)) return json({ error: "Некорректный ID модели." }, 400);
      const failed = await env.DB.prepare(
        "SELECT campaign_id FROM composite_refresh_jobs WHERE model_id=? AND status='failed' ORDER BY updated_at DESC LIMIT 1",
      ).bind(modelId).first<{campaign_id:string}>();
      if (!failed) return json({ error: "Не найдено неудачное задание для этой модели. Повтор не поставлен." }, 409);
      const updated = await env.DB.prepare(
        "UPDATE composite_refresh_jobs SET status='pending',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND model_id=? AND status='failed'",
      ).bind(failed.campaign_id, modelId).run();
      if (!updated.meta.changes) return json({ error: "Статус задания изменился. Обновите список." }, 409);
      await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'composite.refresh.retry', ?)")
        .bind(randomId(), actor.id, JSON.stringify({ campaign_id: failed.campaign_id, model_id: modelId })).run();
      return json({ ok: true, queued: 1, retry: true });
    }
    if (body?.model_ids !== undefined && (!Array.isArray(body.model_ids) || body.model_ids.length > 100 || body.model_ids.some((id: unknown) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,50}$/.test(id)))) {
      return json({ error: "Некорректный список моделей." }, 400);
    }
    try {
      const result = await queueCompositeRefresh(env, Array.isArray(body?.model_ids) ? body.model_ids : null, actor.id, body?.manual === true);
      return json({ ok: true, ...result });
    } catch (error) { return json({ error: error instanceof Error ? error.message : "Не удалось поставить композитки в очередь." }, 409); }
  }
  return json({ error: "Not found" }, 404);
}

function localDateParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}
function localDateTimeToIso(date: string, time: string, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = localDateParts(new Date(guess), timezone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}
function dateKey(year: number, month: number, day: number): string {
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}
async function queueCompositeRefresh(env: Env, modelIds: string[] | null, actorId: string, manual = false): Promise<{ campaignId: string; queued: number }> {
  let campaignId: string;
  if (manual) {
    campaignId = "manual-" + randomId();
    await env.DB.prepare("INSERT INTO profile_refresh_campaigns(id,cycle_key,starts_at,deadline_at,status,completed_at) VALUES(?,?,'1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z','completed',CURRENT_TIMESTAMP)")
      .bind(campaignId, "manual:" + campaignId).run();
  } else {
    const campaign = await env.DB.prepare("SELECT id FROM profile_refresh_campaigns WHERE cycle_key NOT LIKE 'manual:%' ORDER BY starts_at DESC LIMIT 1").first<{ id: string }>();
    if (!campaign) throw new Error("Ежемесячная кампания обновления ещё не запускалась.");
    campaignId = campaign.id;
  }
  let rows: { model_id: string }[];
  if (modelIds?.length) {
    const ids = Array.from(new Set(modelIds)).slice(0, 100);
    const placeholders = ids.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT m.id AS model_id FROM models m
       WHERE m.is_active = 1 AND m.lifecycle_status = 'active' AND m.id IN (${placeholders})`,
    ).bind(...ids).all<{ model_id: string }>();
    rows = result.results ?? [];
  } else {
    const result = await env.DB.prepare(
      `SELECT m.id AS model_id FROM models m
       WHERE m.is_active = 1 AND m.lifecycle_status = 'active'`,
    ).all<{ model_id: string }>();
    rows = result.results ?? [];
  }
  for (const row of rows) {
    await env.DB.prepare(
      `INSERT INTO composite_refresh_jobs(campaign_id,model_id,status,attempts,last_error,updated_at)
       VALUES(?,?,'pending',0,NULL,CURRENT_TIMESTAMP)
       ON CONFLICT(campaign_id,model_id) DO UPDATE SET status='pending',last_error=NULL,updated_at=CURRENT_TIMESTAMP`,
    ).bind(campaignId, row.model_id).run();
  }
  await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'composite.refresh.queued', ?)")
    .bind(randomId(), actorId, JSON.stringify({ campaign_id: campaignId, manual, model_ids: rows.map((row) => row.model_id) })).run();
  return { campaignId, queued: rows.length };
}
async function publishCompositeModel(env: Env, campaignId: string, modelId: string, onStage?: (stage: string) => Promise<void>): Promise<void> {
  await onStage?.("Проверка темы публикации");
  const topic = await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id = 1")
    .first<{ chat_id: string; thread_id: number }>();
  if (!topic) throw new Error("Тема «КОМПОЗИТКИ» не подключена.");
  await onStage?.("Загрузка анкеты модели");
  const model = await env.DB.prepare(
    `SELECT m.id,m.first_name,m.last_name,p.height_cm,p.bust_cm,p.waist_cm,p.hips_cm,
      p.clothing_size,p.shoe_size,p.hair_color,p.eye_color
     FROM models m LEFT JOIN model_profiles p ON p.model_id=m.id
     WHERE m.id=? AND m.is_active=1 AND m.lifecycle_status='active'`,
  ).bind(modelId).first<SecretaryModelRow>();
  if (!model) throw new Error("Модель не найдена в активной базе.");
  await onStage?.("Проверка фотографий модели");
  const result = await env.DB.prepare("SELECT position,telegram_file_id FROM model_telegram_photos WHERE model_id=? ORDER BY position")
    .bind(modelId).all<{ position: number; telegram_file_id: string }>();
  const photos = result.results ?? [];
  if (photos.length !== 4 || photos.some((photo, index) => photo.position !== index + 1)) {
    throw new Error("Для модели не загружены все четыре фотографии.");
  }
  const png = await renderCompositePng(env, model, photos.map((photo) => photo.telegram_file_id), onStage);
  await onStage?.("Отправка PNG в Telegram");
  const messageId = await sendCompositePng(env, Number(topic.chat_id), topic.thread_id, png, model.first_name + " " + model.last_name + " · InterModels");
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("Telegram не вернул ID новой композитки.");
  const old = await env.DB.prepare("SELECT chat_id,message_id FROM composite_topic_publications WHERE model_id=?")
    .bind(modelId).first<{ chat_id: string; message_id: number }>();
  if (old) {
    try {
      await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: old.chat_id, message_id: old.message_id });
    } catch (error) {
      console.error("Old composite publication could not be deleted after new publication", { modelId, oldMessageId: old.message_id, error: compositeErrorText(error) });
    }
  }
  await env.DB.prepare(
    `INSERT INTO composite_topic_publications(model_id,chat_id,thread_id,message_id,campaign_id,published_at)
     VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(model_id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,
       message_id=excluded.message_id,campaign_id=excluded.campaign_id,published_at=CURRENT_TIMESTAMP`,
  ).bind(modelId, topic.chat_id, topic.thread_id, messageId, campaignId).run();
}
async function processCompositeRefreshJobs(env: Env): Promise<void> {
  // A job that has made no progress for 10 minutes is failed explicitly, not silently requeued forever.
  await env.DB.prepare("UPDATE composite_refresh_jobs SET status='failed',last_error=CASE WHEN last_error IS NULL OR last_error='' THEN 'Тайм-аут: задание не завершилось за 10 минут.' ELSE 'Тайм-аут после этапа: ' || last_error END,updated_at=CURRENT_TIMESTAMP WHERE status='processing' AND updated_at < datetime('now','-10 minutes')").run();
  const jobs = await env.DB.prepare(
    `SELECT campaign_id,model_id FROM composite_refresh_jobs
     WHERE status='pending' ORDER BY created_at LIMIT 2`,
  ).all<{ campaign_id: string; model_id: string }>();
  for (const job of jobs.results ?? []) {
    const claim = await env.DB.prepare(
      "UPDATE composite_refresh_jobs SET status='processing',attempts=attempts+1,last_error='Запуск задания',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND model_id=? AND status='pending'",
    ).bind(job.campaign_id, job.model_id).run();
    if (!claim.meta.changes) continue;
    const onStage = async (stage: string) => {
      await env.DB.prepare("UPDATE composite_refresh_jobs SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND model_id=? AND status='processing'")
        .bind(stage, job.campaign_id, job.model_id).run();
    };
    try {
      await publishCompositeModel(env, job.campaign_id, job.model_id, onStage);
      await env.DB.prepare("UPDATE composite_refresh_jobs SET status='published',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND model_id=?")
        .bind(job.campaign_id, job.model_id).run();
    } catch (error) {
      const details = compositeErrorText(error).slice(0, 1500);
      await env.DB.prepare("UPDATE composite_refresh_jobs SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND model_id=?")
        .bind(details, job.campaign_id, job.model_id).run();
      console.error("Composite refresh job failed", { campaignId: job.campaign_id, modelId: job.model_id, error: details });
    }
  }
}

async function createDueRefreshCampaign(env: Env, now: Date): Promise<void> {
  const settings = await env.DB.prepare(
    "SELECT cycle_day, timezone, campaign_start_time, reminder_times_json FROM director_refresh_settings WHERE id = 1",
  ).first<{ cycle_day: number; timezone: string; campaign_start_time: string; reminder_times_json: string }>();
  if (!settings) return;
  let local: ReturnType<typeof localDateParts>;
  try { local = localDateParts(now, settings.timezone); } catch (error) {
    console.error("Invalid profile refresh timezone", settings.timezone, error); return;
  }
  if (local.day < settings.cycle_day) return;
  const cycleKey = String(local.year) + "-" + String(local.month).padStart(2, "0");
  const startDate = dateKey(local.year, local.month, settings.cycle_day);
  const startsAt = localDateTimeToIso(startDate, settings.campaign_start_time, settings.timezone);
  const deadlineMs = Date.parse(startsAt) + 48 * 60 * 60 * 1000;
  // Never create a campaign retroactively after its 48-hour window has already elapsed.
  if (now.getTime() < Date.parse(startsAt) || now.getTime() >= deadlineMs) return;
  const existing = await env.DB.prepare("SELECT id FROM profile_refresh_campaigns WHERE cycle_key = ?").bind(cycleKey).first<{ id: string }>();
  if (existing) return;
  let times: string[];
  try { times = JSON.parse(settings.reminder_times_json) as string[]; } catch { times = ["09:00", "20:00", "09:00", "20:00"]; }
  if (!Array.isArray(times) || times.length !== 4 || times.some((time) => typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    times = ["09:00", "20:00", "09:00", "20:00"];
  }
  const campaignId = randomId();
  const deadlineAt = new Date(Date.parse(startsAt) + 48 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO profile_refresh_campaigns(id,cycle_key,starts_at,deadline_at) VALUES(?,?,?,?)",
  ).bind(campaignId, cycleKey, startsAt, deadlineAt).run();
  const campaign = await env.DB.prepare("SELECT id FROM profile_refresh_campaigns WHERE cycle_key = ?").bind(cycleKey).first<{ id: string }>();
  if (!campaign) return;
  const active = await env.DB.prepare("SELECT id FROM models WHERE is_active = 1 AND lifecycle_status = 'active'").all<{ id: string }>();
  for (const model of active.results ?? []) {
    await env.DB.prepare("INSERT OR IGNORE INTO profile_refresh_members(campaign_id,model_id) VALUES(?,?)").bind(campaign.id, model.id).run();
  }
  for (let index = 0; index < 4; index++) {
    const dayOffset = index < 2 ? 0 : 1;
    const reminderDate = new Date(Date.UTC(local.year, local.month - 1, settings.cycle_day + dayOffset));
    const date = dateKey(reminderDate.getUTCFullYear(), reminderDate.getUTCMonth() + 1, reminderDate.getUTCDate());
    const scheduledAt = localDateTimeToIso(date, times[index], settings.timezone);
    await env.DB.prepare("INSERT OR IGNORE INTO profile_refresh_reminders(campaign_id,reminder_index,scheduled_at) VALUES(?,?,?)")
      .bind(campaign.id, index + 1, scheduledAt).run();
  }
  console.info("Monthly profile refresh campaign created", { campaignId: campaign.id, cycleKey, models: active.results?.length ?? 0, deadlineAt });
}
async function processRefreshCampaigns(env: Env): Promise<void> {
  const now = new Date();
  // Recover campaigns accidentally created after their deadline (for example, on first deployment mid-month).
  const stale = await env.DB.prepare(
    "SELECT id FROM profile_refresh_campaigns WHERE julianday(created_at) > julianday(deadline_at)",
  ).all<{ id: string }>();
  for (const item of stale.results ?? []) {
    await env.DB.prepare(
      "UPDATE models SET lifecycle_status='active' WHERE id IN (SELECT model_id FROM profile_refresh_members WHERE campaign_id=? AND status='frozen') AND lifecycle_status='frozen'",
    ).bind(item.id).run();
    await env.DB.prepare("DELETE FROM composite_refresh_jobs WHERE campaign_id=?").bind(item.id).run();
    await env.DB.prepare("DELETE FROM profile_refresh_reminders WHERE campaign_id=?").bind(item.id).run();
    await env.DB.prepare("DELETE FROM profile_refresh_members WHERE campaign_id=?").bind(item.id).run();
    await env.DB.prepare("DELETE FROM profile_refresh_campaigns WHERE id=?").bind(item.id).run();
    console.warn("Removed retroactively-created expired profile refresh campaign", { campaignId: item.id });
  }
  await createDueRefreshCampaign(env, now);
  const campaigns = await env.DB.prepare(
    "SELECT id, deadline_at FROM profile_refresh_campaigns WHERE status = 'open' ORDER BY starts_at",
  ).all<{ id: string; deadline_at: string }>();
  for (const campaign of campaigns.results ?? []) {
    const pendingNotifications = await env.DB.prepare(
      `SELECT m.id, m.telegram_user_id, r.model_id
       FROM profile_refresh_members r JOIN models m ON m.id = r.model_id
       WHERE r.campaign_id = ? AND r.notified_at IS NULL AND r.status = 'pending'
         AND m.is_active = 1 AND m.telegram_user_id IS NOT NULL`,
    ).bind(campaign.id).all<{ id: string; telegram_user_id: string; model_id: string }>();
    for (const model of pendingNotifications.results ?? []) {
      try {
        await sendModel(env, model.telegram_user_id,
          "Настало время ежемесячного обновления параметров InterModels.\n\nУ вас есть 48 часов, чтобы проверить и обновить анкету. Отправьте /profile, чтобы начать.");
        await env.DB.prepare("UPDATE profile_refresh_members SET notified_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND model_id = ? AND notified_at IS NULL")
          .bind(campaign.id, model.model_id).run();
      } catch (error) { console.error("Unable to notify model about monthly profile refresh", { modelId: model.model_id, error: compositeErrorText(error) }); }
    }
    const dueReminders = await env.DB.prepare(
      "SELECT reminder_index FROM profile_refresh_reminders WHERE campaign_id = ? AND sent_at IS NULL AND scheduled_at <= ? ORDER BY reminder_index",
    ).bind(campaign.id, now.toISOString()).all<{ reminder_index: number }>();
    for (const reminder of dueReminders.results ?? []) {
      const stats = await env.DB.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'updated' THEN 1 ELSE 0 END) AS updated FROM profile_refresh_members WHERE campaign_id = ?",
      ).bind(campaign.id).first<{ total: number; updated: number | null }>();
      const total = stats?.total ?? 0, updated = stats?.updated ?? 0;
      const remainingMs = Math.max(0, Date.parse(campaign.deadline_at) - now.getTime());
      const hours = Math.ceil(remainingMs / 3600000);
      try {
        await sendDirector(env,
          "Процесс обновления параметров:\n" +
          "Моделей: " + total + " | Обновлено: " + updated +
          "\nОжидают: " + Math.max(0, total - updated) +
          "\nДо дедлайна: " + hours + " ч.");
        await env.DB.prepare("UPDATE profile_refresh_reminders SET sent_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND reminder_index = ? AND sent_at IS NULL")
          .bind(campaign.id, reminder.reminder_index).run();
      } catch (error) { console.error("Unable to send director refresh progress", { campaignId: campaign.id, reminder: reminder.reminder_index, error: compositeErrorText(error) }); }
    }
    if (Date.parse(campaign.deadline_at) <= now.getTime()) {
      const late = await env.DB.prepare(
        `SELECT m.id, m.telegram_user_id FROM profile_refresh_members r
         JOIN models m ON m.id = r.model_id
         WHERE r.campaign_id = ? AND r.status = 'pending' AND m.is_active = 1`,
      ).bind(campaign.id).all<{ id: string; telegram_user_id: string | null }>();
      for (const model of late.results ?? []) {
        await env.DB.prepare("UPDATE models SET lifecycle_status = 'frozen' WHERE id = ? AND is_active = 1").bind(model.id).run();
        await env.DB.prepare("UPDATE profile_refresh_members SET status = 'frozen', frozen_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND model_id = ? AND status = 'pending'")
          .bind(campaign.id, model.id).run();
        if (model.telegram_user_id) {
          try { await sendModel(env, model.telegram_user_id, "🥶\n\nУпс, кто-то замёрз\n\nВаша анкета заморожена и не отображается в базе.\nОбновите параметры, чтобы возобновить работу."); }
          catch (error) { console.error("Unable to send model freeze notice", { modelId: model.id, error: compositeErrorText(error) }); }
        }
      }
      const finalStats = await env.DB.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN status='updated' THEN 1 ELSE 0 END) AS updated, SUM(CASE WHEN status='frozen' THEN 1 ELSE 0 END) AS frozen FROM profile_refresh_members WHERE campaign_id=?",
      ).bind(campaign.id).first<{total:number;updated:number|null;frozen:number|null}>();
      await env.DB.prepare("UPDATE profile_refresh_campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'")
        .bind(campaign.id).run();
      const updatedCount = finalStats?.updated ?? 0;
      const finalText = "Ежемесячное обновление параметров завершено.\n\nВсего моделей: " + (finalStats?.total ?? 0) +
        "\nОбновили анкету: " + updatedCount +
        "\nЗаморожено: " + (finalStats?.frozen ?? late.results?.length ?? 0) + ".";
      await sendDirector(env, finalText, updatedCount > 0 ? {
        inline_keyboard: [[{ text: "🔄 Обновить Comp", callback_data: "comprefresh:" + campaign.id }]],
      } : undefined);
    }
  }
}

async function processPendingSecretaryAlbums(env: Env): Promise<void> {
  // Webhook requests can race or time out after all four Telegram updates were stored.
  // Re-enter the same idempotent handler from Cron as a recovery path.
  const pending = await env.DB.prepare(
    `SELECT
       a.chat_id, a.thread_id, a.uploader_id, a.media_group_id,
       (SELECT x.message_id FROM secretary_photo_album_items x
        WHERE x.chat_id = a.chat_id AND x.thread_id = a.thread_id
          AND x.uploader_id = a.uploader_id AND x.media_group_id = a.media_group_id
        ORDER BY x.message_id LIMIT 1) AS message_id,
       (SELECT x.telegram_file_id FROM secretary_photo_album_items x
        WHERE x.chat_id = a.chat_id AND x.thread_id = a.thread_id
          AND x.uploader_id = a.uploader_id AND x.media_group_id = a.media_group_id
        ORDER BY x.message_id LIMIT 1) AS file_id,
       (SELECT x.telegram_file_unique_id FROM secretary_photo_album_items x
        WHERE x.chat_id = a.chat_id AND x.thread_id = a.thread_id
          AND x.uploader_id = a.uploader_id AND x.media_group_id = a.media_group_id
        ORDER BY x.message_id LIMIT 1) AS file_unique_id
     FROM secretary_photo_album_items a
     GROUP BY a.chat_id, a.thread_id, a.uploader_id, a.media_group_id
     HAVING COUNT(*) = 4
       AND MIN(a.created_at) <= datetime('now', '-10 seconds')
       AND (MAX(a.processed_at) IS NULL OR MAX(a.processed_at) < datetime('now', '-5 minutes'))
     LIMIT 10`,
  ).all<{
    chat_id: string; thread_id: number; uploader_id: string; media_group_id: string;
    message_id: number; file_id: string; file_unique_id: string;
  }>();
  for (const album of pending.results ?? []) {
    try {
      await handleSecretaryAlbumMessage(env, {
        message_id: album.message_id,
        message_thread_id: album.thread_id,
        media_group_id: album.media_group_id,
        chat: { id: Number(album.chat_id), type: "supergroup" },
        photo: [{ file_id: album.file_id, file_unique_id: album.file_unique_id, width: 0, height: 0 }],
      }, album.uploader_id);
    } catch (error) {
      console.error("Secretary album Cron recovery failed", {
        chatId: album.chat_id, threadId: album.thread_id,
        mediaGroupId: album.media_group_id, error: compositeErrorText(error),
      });
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "intermodels" });
    if (url.pathname === "/app" && request.method === "GET") return appHtml();
    if (url.pathname.startsWith("/api/director/")) {
      try { return await handleDirectorApi(request, env, url); }
      catch (error) { console.error("Director API failed", error); return json({ error: "Внутренняя ошибка." }, 500); }
    }
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    const isModel = url.pathname === "/webhook/model";
    const isDirector = url.pathname === "/webhook/director";
    const isSecretary = url.pathname === "/webhook/secretary";
    if (!isModel && !isDirector && !isSecretary) return json({ error: "Not found" }, 404);
    const route = isModel ? "model" : isDirector ? "director" : "secretary";
    const secret = isModel ? env.MODEL_WEBHOOK_SECRET : isDirector ? env.DIRECTOR_WEBHOOK_SECRET : env.SECRETARY_WEBHOOK_SECRET;
    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!secret || suppliedSecret !== secret) {
      console.warn("Telegram webhook authorization rejected", {
        route, method: request.method, secretConfigured: Boolean(secret),
        secretHeaderPresent: suppliedSecret !== null, secretHeaderLength: suppliedSecret?.length ?? 0,
        configuredSecretLength: secret?.length ?? 0,
      });
      return json({ error: "Unauthorized" }, 401);
    }
    let update: TelegramUpdate;
    try { update = await request.json() as TelegramUpdate; }
    catch (error) {
      console.error("Telegram webhook received invalid JSON", { route, error: compositeErrorText(error) });
      return json({ error: "Invalid JSON" }, 400);
    }
    console.info("Telegram webhook update received", {
      route, updateId: update.update_id ?? null,
      updateType: update.message ? "message" : update.callback_query ? "callback_query" : "other",
      chatType: update.message?.chat?.type ?? update.callback_query?.message?.chat?.type ?? null,
      chatId: update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? null,
      senderId: update.message?.from?.id ?? update.callback_query?.from?.id ?? null,
      textCommand: update.message?.text?.trim().match(/^\/[A-Za-z0-9_]+/)?.[0] ?? (update.message?.text ? "plain_text" : null),
      callbackData: (update.callback_query?.data ?? "").slice(0, 80),
    });
    try {
      const isCompositeUpdate = isSecretary && (
        /^\/comp(?:@\w+)?\s+/i.test(update.message?.text ?? "") ||
        ["csel:", "composite:"].some((prefix) => (update.callback_query?.data ?? "").startsWith(prefix))
      );
      if (isCompositeUpdate && typeof update.update_id === "number") {
        const claim = await env.DB.prepare(
          "INSERT OR IGNORE INTO telegram_processed_updates (bot_key, update_id) VALUES ('secretary', ?)",
        ).bind(update.update_id).run();
        if (!claim.meta.changes) return json({ ok: true, duplicate: true });
      }
      if (isModel && update.message) await handleModelMessage(env, update.message);
      if (isDirector && update.message) await handleDirectorMessage(env, update.message);
      if (isDirector && update.callback_query) await handleDirectorCallback(env, update.callback_query);
      if (isSecretary && update.message) await handleSecretaryMessage(env, update.message);
      if (isSecretary && update.callback_query) await handleSecretaryCallback(env, update.callback_query);
      console.info("Telegram webhook update processed", { route, updateId: update.update_id ?? null });
      return json({ ok: true });
    } catch (error) {
      console.error("Webhook handler failed", { route, updateId: update.update_id ?? null, error: compositeErrorText(error) });
      return json({ ok: false }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([processRefreshCampaigns(env), processCompositeRefreshJobs(env), processPendingSecretaryAlbums(env)]).then(() => undefined));
  },
};
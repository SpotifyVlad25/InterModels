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
  text?: string; caption?: string; media_group_id?: string; photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>; contact?: { phone_number: string; user_id?: number };
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
  const message = `Мария, поступила новая заявка на подключение InterModels\n\nПользователь: ${user.first_name ?? ""} ${user.last_name ?? ""} (${userLabel})\nTelegram ID: ${user.id}\nСпособ поиска: ${method === "name" ? "ФИО" : "телефон"}\nВведённые данные: ${submittedValue}\n\nНайденные анкеты:\n${candidateLines}\n\nВыберите правильную анкету или отклоните заявку.`;
  const keyboard = [
    ...candidates.map((m) => [{ text: `Принять: ${m.first_name} ${m.last_name}`.slice(0, 60), callback_data: `a:${requestId}:${m.id}` }]),
    [{ text: "Отклонить заявку", callback_data: `r:${requestId}` }],
  ];
  await sendDirector(env, message, { inline_keyboard: keyboard });
  // The owner has full request-management permissions and receives the same decision controls as the director.
  if (env.OWNER_TELEGRAM_ID && env.OWNER_TELEGRAM_ID !== env.DIRECTOR_TELEGRAM_ID) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: env.OWNER_TELEGRAM_ID,
      text: message,
      reply_markup: { inline_keyboard: keyboard },
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
async function hasStaffPermission(env: Env, telegramId: string, permission: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT permissions_json FROM agency_staff_access WHERE telegram_user_id = ? AND is_active = 1",
  ).bind(telegramId).first<{ permissions_json: string }>();
  if (!row) return false;
  try {
    const permissions = JSON.parse(row.permissions_json) as Record<string, boolean>;
    return permissions[permission] === true || permissions["*"] === true;
  } catch {
    return false;
  }
}
async function canManageRequests(env: Env, telegramId: string): Promise<boolean> {  // OWNER_TELEGRAM_ID is the temporary full-access account during setup.
  if (telegramId === env.OWNER_TELEGRAM_ID || telegramId === env.DIRECTOR_TELEGRAM_ID) return true;
  return hasStaffPermission(env, telegramId, "requests.manage");
}
async function handleDirectorCallback(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  if (!(await canManageRequests(env, String(callback.from.id)))) {
    await answerCallback(env, callback, "Недостаточно прав.", true); return;
  }
  const data = callback.data ?? "";
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
  const isDirector = senderId === env.DIRECTOR_TELEGRAM_ID;
  const isOwner = Boolean(env.OWNER_TELEGRAM_ID) && senderId === env.OWNER_TELEGRAM_ID;
  const isStaff = await hasStaffPermission(env, senderId, "profile.view") || await hasStaffPermission(env, senderId, "composite.generate");
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  if (!isDirector && !isOwner && !isStaff) {
    if (!isGroup) await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: `Доступ пока не подключён. Ваш Telegram ID: ${senderId}. Передайте его администратору InterModels для активации.` });
    return;
  }
  if (message.chat.type === "private" && (message.text?.trim() === "Обновить Comp" || /^\/refresh_comp(?:@\w+)?$/i.test(message.text?.trim() ?? ""))) {
    if (!(await actorHasPermission(env, senderId, "composite.generate"))) {
      await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "У вас нет права запускать обновление композиток." });
      return;
    }
    try {
      const result = await queueCompositeRefresh(env, null, senderId);
      await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: result.queued
          ? "Обновление Comp запущено. В очереди: " + result.queued + " моделей. Результаты появятся в теме «КОМПОЗИТКИ»."
          : "Нет моделей с обновлёнными параметрами для публикации Comp.",
      });
    } catch (error) {
      await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: error instanceof Error ? error.message : "Не удалось запустить обновление Comp." });
    }
    return;
  }
  if (message.text?.startsWith("/start")) {
    if (isDirector) await saveTopic(env, "director", message);
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: isDirector
        ? "InterModels Director подключён. У вас полный доступ."
        : isOwner
          ? "InterModels Owner подключён. На период настройки у вас временный полный доступ, включая решения по заявкам."
          : "InterModels Assistant подключён. Ваши возможности определяются выданными директором правами.",
      ...((isDirector || isOwner) && message.chat.type === "private" ? {
        reply_markup: { keyboard: [[{ text: "Открыть Mini App", web_app: { url: "https://intermodels.spotify-vlad25.workers.dev/app" } }], [{ text: "Обновить Comp" }]], resize_keyboard: true },
      } : {}),
    });
  } else if (message.text?.startsWith("/help")) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: isDirector || isOwner
        ? "Команды:\n/start — подключить бота\n/help — помощь\n\nУ вас полный доступ к управлению заявками."
        : "Команды:\n/start — подключить бота\n/help — помощь\n\nДоступные действия определяются выданными вам правами.",
    });
  }
}



async function secretaryAllowed(env: Env, telegramId: string): Promise<boolean> {
  if (telegramId === env.OWNER_TELEGRAM_ID || telegramId === env.DIRECTOR_TELEGRAM_ID) return true;
  return hasStaffPermission(env, telegramId, "composite.generate");
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
  const response = await fetch("https://api.telegram.org/file/bot" + env.SECRETARY_BOT_TOKEN + "/" + path);
  if (!response.ok) throw new Error("Unable to download Telegram photo");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error("Photo size is invalid");
  const mime = path.toLowerCase().endsWith(".png") ? "image/png" : path.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
  return "data:" + mime + ";base64," + bytesToBase64(bytes);
}
function compositeSvg(model: SecretaryModelRow, photos: string[]): string {
  const name = escapeXml((model.first_name + " " + model.last_name).toUpperCase());
  const values = [
    model.height_cm != null ? "HEIGHT  " + model.height_cm + " CM" : null,
    model.bust_cm != null ? "BUST  " + model.bust_cm + " CM" : null,
    model.waist_cm != null ? "WAIST  " + model.waist_cm + " CM" : null,
    model.hips_cm != null ? "HIPS  " + model.hips_cm + " CM" : null,
    model.clothing_size ? "CLOTHING  " + model.clothing_size : null,
    model.shoe_size ? "SHOES  " + model.shoe_size : null,
    model.hair_color ? "HAIR  " + model.hair_color : null,
    model.eye_color ? "EYES  " + model.eye_color : null,
  ].filter((v): v is string => Boolean(v));
  const details = values.map((v, i) => `<text x="990" y="${1770 + i * 58}" class="detail">${escapeXml(v)}</text>`).join("");
  const img = (data: string, x: number, y: number, w: number, h: number) =>
    `<image href="${data}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="2260" viewBox="0 0 1600 2260">
  <rect width="1600" height="2260" fill="#fff"/>
  <text x="90" y="70" class="brand">INTERMODELS</text><text x="1510" y="70" text-anchor="end" class="small">MODEL PORTFOLIO</text>
  <defs><clipPath id="a"><rect x="90" y="110" width="820" height="1093"/></clipPath><clipPath id="b"><rect x="950" y="110" width="560" height="700"/></clipPath><clipPath id="c"><rect x="950" y="850" width="560" height="700"/></clipPath><clipPath id="d"><rect x="90" y="1240" width="820" height="820"/></clipPath></defs>
  <g clip-path="url(#a)"><rect x="90" y="110" width="820" height="1093" fill="#eee"/>${img(photos[0],90,110,820,1093)}</g>
  <g clip-path="url(#b)"><rect x="950" y="110" width="560" height="700" fill="#eee"/>${img(photos[1],950,110,560,700)}</g>
  <g clip-path="url(#c)"><rect x="950" y="850" width="560" height="700" fill="#eee"/>${img(photos[2],950,850,560,700)}</g>
  <g clip-path="url(#d)"><rect x="90" y="1240" width="820" height="820" fill="#eee"/>${img(photos[3],90,1240,820,820)}</g>
  <text x="950" y="1645" class="eyebrow">INTERMODELS / COMPOSITE CARD</text>
  <text x="950" y="1705" class="name">${name}</text>${details}
  <line x1="90" y1="2130" x2="1510" y2="2130" stroke="#222" stroke-width="2"/>
  <text x="90" y="2190" class="brand">INTERMODELS</text><text x="1510" y="2190" text-anchor="end" class="small">PROFESSIONAL MODEL AGENCY</text>
  <style>
    text{font-family:Roboto,sans-serif;fill:#171717}.brand{font-size:30px;font-weight:700;letter-spacing:8px}.small{font-size:17px;letter-spacing:3px;fill:#777}.eyebrow{font-size:17px;letter-spacing:4px;fill:#777}.name{font-size:44px;font-weight:700;letter-spacing:1px}.detail{font-size:24px;letter-spacing:1.5px}
  </style></svg>`;
}
function compositeErrorText(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  if (error instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(error)) || "ArrayBuffer (" + error.byteLength + " bytes)";
  if (ArrayBuffer.isView(error)) {
    const view = new Uint8Array(error.buffer, error.byteOffset, error.byteLength);
    return new TextDecoder().decode(view) || Object.prototype.toString.call(error) + " (" + view.byteLength + " bytes)";
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}
async function renderCompositePng(env: Env, model: SecretaryModelRow, fileIds: string[]): Promise<Uint8Array> {
  let stage = "init_wasm";
  try {
    await ensureResvg();
    stage = "download_photos";
    const photos = await Promise.all(fileIds.map((id) => getSecretaryPhotoData(env, id)));
    stage = "build_svg";
    const svg = compositeSvg(model, photos);
    stage = "create_renderer";
    const renderer = new Resvg(svg, { font: { fontBuffers: [robotoCyrillic, robotoLatin], defaultFontFamily: "Roboto", loadSystemFonts: false } });
    try {
      stage = "rasterize_png";
      return renderer.render().asPng();
    } finally { renderer.free(); }
  } catch (error) {
    const details = compositeErrorText(error);
    console.error("Composite PNG render stage failed", { modelId: model.id, renderStage: stage, error: details });
    throw new Error("Composite PNG " + stage + ": " + details.slice(0, 1800));
  }
}

async function saveSecretaryPhotoSet(
  env: Env, modelId: string, photos: Array<{file_id:string;file_unique_id:string}>,
  senderId: string, chatId: number, threadId: number,
): Promise<void> {
  await env.DB.prepare("DELETE FROM model_telegram_photos WHERE model_id = ?").bind(modelId).run();
  for (let index = 0; index < photos.length; index++) {
    const photo = photos[index];
    await env.DB.prepare("INSERT INTO model_telegram_photos (model_id, position, telegram_file_id, telegram_file_unique_id, uploaded_by, source_chat_id, source_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(modelId, index + 1, photo.file_id, photo.file_unique_id, senderId, String(chatId), threadId).run();
  }
}
async function handleSecretaryAlbumMessage(env: Env, message: TelegramMessage, senderId: string): Promise<void> {
  const albumId = message.media_group_id!;
  const threadId = message.message_thread_id;
  if (threadId === undefined) return;
  const photo = message.photo?.[message.photo.length - 1];
  if (!photo) return;
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
  ).bind(String(message.chat.id), threadId, senderId, albumId, message.message_id, modelId, photo.file_id, photo.file_unique_id).run();
  if (modelId) {
    await env.DB.prepare(
      "UPDATE secretary_photo_album_items SET model_id = ? WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? AND model_id IS NULL",
    ).bind(modelId, String(message.chat.id), threadId, senderId, albumId).run();
  }
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
  if (items.length !== 4 || items.some((item) => !item.model_id)) return;
  const resolvedModelId = items[0].model_id!;
  if (items.some((item) => item.model_id !== resolvedModelId)) {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "У фотографий альбома должно быть одно ФИО в подписи первого снимка. Отправьте комплект заново." });
    return;
  }
  await saveSecretaryPhotoSet(env, resolvedModelId, items.map(({file_id,file_unique_id}) => ({file_id,file_unique_id})), senderId, message.chat.id, threadId);
  await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
    .bind(String(message.chat.id), threadId, senderId, albumId).run();
  const model = await env.DB.prepare("SELECT first_name, last_name FROM models WHERE id = ?").bind(resolvedModelId).first<{first_name:string;last_name:string}>();
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "Готово: альбом из 4 фотографий для " + (model?.first_name ?? "") + " " + (model?.last_name ?? "") + " сохранён в правильном порядке." });
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
  const photoResponse = await fetch(endpoint + "sendPhoto", { method: "POST", body: makeForm("photo") });
  const photoResult: any = await photoResponse.json().catch(() => null);
  if (photoResponse.ok && photoResult?.ok) return Number(photoResult.result?.message_id);

  const photoError = photoResult?.description ?? `HTTP ${photoResponse.status}`;
  const documentResponse = await fetch(endpoint + "sendDocument", { method: "POST", body: makeForm("document") });
  const documentResult: any = await documentResponse.json().catch(() => null);
  if (!documentResponse.ok || !documentResult?.ok) {
    const documentError = documentResult?.description ?? `HTTP ${documentResponse.status}`;
    throw new Error(`Telegram delivery failed (sendPhoto: ${photoError}; sendDocument: ${documentError})`);
  }
  return Number(documentResult.result?.message_id);
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
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Для этой модели ещё не загружены все четыре фотографии. Сначала добавьте их в тему /COMP." }); return;
  }
  const status = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id, message_thread_id: message.message_thread_id,
    text: "Готовлю композитку для " + model.first_name + " " + model.last_name + "…",
  });
  const statusMessageId = status.result?.message_id;
  let compositeStage = "render_png";
  try {
    const png = await renderCompositePng(env, model, photos.map((p) => p.telegram_file_id));
    compositeStage = "deliver_png";
    const newMessageId = await sendCompositePng(env, message.chat.id, message.message_thread_id!, png, model.first_name + " " + model.last_name + " · InterModels");
    const oldPublication = await env.DB.prepare("SELECT chat_id,message_id FROM composite_topic_publications WHERE model_id=?")
      .bind(model.id).first<{ chat_id: string; message_id: number }>();
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
    compositeStage = "delete_status";
    if (statusMessageId) {
      await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", {
        chat_id: message.chat.id, message_id: statusMessageId,
      });
    }
  } catch (error) {
    const details = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
    console.error("Composite generation failed", { modelId: model.id, stage: compositeStage, ...details });
    if (statusMessageId) {
      try {
        await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
          chat_id: message.chat.id, message_id: statusMessageId,
          text: "Не удалось создать композитку. Ошибка записана, можно попробовать ещё раз позже.",
        });
      } catch (notifyError) {
        console.error("Unable to report composite generation failure", notifyError);
      }
    }
  }
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
    if (senderId !== env.OWNER_TELEGRAM_ID && senderId !== env.DIRECTOR_TELEGRAM_ID) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Настроить тему композиток может только владелец или директор." }); return;
    }
    await env.DB.prepare("INSERT INTO secretary_composite_topics (id, chat_id, thread_id, configured_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, thread_id=excluded.thread_id, configured_by=excluded.configured_by")
      .bind(String(message.chat.id), message.message_thread_id, senderId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Тема «КОМПОЗИТКИ» подключена. Используйте /comp Имя Фамилия для генерации PNG." }); return;
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
  if (/^\/comp_setup(?:@\w+)?$/i.test(command)) {
    if (senderId !== env.OWNER_TELEGRAM_ID && senderId !== env.DIRECTOR_TELEGRAM_ID) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Настроить фототеку может только владелец или директор." });
      return;
    }
    await env.DB.prepare("INSERT INTO secretary_photo_topics (id, chat_id, thread_id, configured_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, thread_id=excluded.thread_id, configured_by=excluded.configured_by")
      .bind(String(message.chat.id), message.message_thread_id, senderId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Тема /COMP подключена. Отправляйте альбом из 4 фотографий: подпись «Имя Фамилия» у первого снимка." });
    return;
  }
  const topic = await env.DB.prepare("SELECT chat_id, thread_id FROM secretary_photo_topics WHERE id = 1").first<{chat_id:string;thread_id:number}>();
  if (!topic || topic.chat_id !== String(message.chat.id) || topic.thread_id !== message.message_thread_id) return;
  if (!(await secretaryAllowed(env, senderId)) || !message.photo?.length) return;
  if (message.media_group_id) {
    await handleSecretaryAlbumMessage(env, message, senderId);
    return;
  }
  const bestPhoto = message.photo[message.photo.length - 1];
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
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: next === 5 ? "Готово: для " + (model?.first_name ?? "") + " " + (model?.last_name ?? "") + " сохранены все 4 фотографии." : "Фото " + batch.next_position + " из 4 принято. Осталось " + (4 - batch.next_position) + "." });
}
async function sendSecretaryCompositeSources(env: Env, chatId: number, model: SecretaryModelRow): Promise<void> {
  const result = await env.DB.prepare("SELECT position, telegram_file_id FROM model_telegram_photos WHERE model_id = ? ORDER BY position").bind(model.id).all<{position:number;telegram_file_id:string}>();
  const photos = result.results ?? [];
  if (photos.length !== 4 || photos.some((photo, index) => photo.position !== index + 1)) {
    await sendSecretary(env, chatId, secretaryProfileText(model).replace("Генерация графической композитки ещё подключается. Сейчас доступен поиск анкеты и её параметров.", "Фотографии ещё не загружены полностью. В теме /COMP нужны четыре снимка."));
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
      "Секретарь InterModels\n\n/comp Фамилия — найти анкету модели.\n\nЕсли совпадений несколько, выберите нужную модель из списка.");
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

const STAFF_PERMISSIONS = ["profile.view","profile.edit","photos.manage","composite.generate","requests.manage","staff.manage"] as const;
type StaffPermission = typeof STAFF_PERMISSIONS[number];
interface MiniAppActor { id: string; first_name?: string; last_name?: string; username?: string; }
function bytesToHex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2,"0")).join(""); }
async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}
async function validateMiniAppInitData(initData: string, botToken: string): Promise<MiniAppActor | null> {
  if (!initData || initData.length > 8192 || !botToken) return null;
  const params = new URLSearchParams(initData), suppliedHash = params.get("hash"), authDate = Number(params.get("auth_date")), userRaw = params.get("user");
  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash) || !Number.isFinite(authDate) || Math.abs(Date.now()/1000-authDate)>86400 || !userRaw) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
  const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const actual = bytesToHex(await hmacSha256(secret, check));
  let diff=0; for(let i=0;i<actual.length;i++) diff |= actual.charCodeAt(i)^suppliedHash.toLowerCase().charCodeAt(i);
  if(diff!==0) return null;
  try { const user=JSON.parse(userRaw) as MiniAppActor; return Number.isSafeInteger(Number(user.id))?{...user,id:String(user.id)}:null; } catch { return null; }
}
async function miniAppActor(request: Request, env: Env): Promise<MiniAppActor|null> {
  const match=(request.headers.get("Authorization")??"").match(/^tma (.+)$/);
  return match ? validateMiniAppInitData(match[1],env.DIRECTOR_BOT_TOKEN) : null;
}
async function actorHasPermission(env: Env, actorId: string, permission: StaffPermission): Promise<boolean> {
  if(actorId===env.OWNER_TELEGRAM_ID || actorId===env.DIRECTOR_TELEGRAM_ID) return true;
  return hasStaffPermission(env,actorId,permission);
}
function appHtml(): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>InterModels</title><script src="https://telegram.org/js/telegram-web-app.js"></script><style>
  *{box-sizing:border-box}body{font:15px system-ui;margin:0;padding:16px;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}
  h1{font-size:23px;margin:4px 0}h2{font-size:18px;margin:0 0 12px}.muted{opacity:.68;font-size:13px}
  .panel{background:var(--tg-theme-secondary-bg-color,#eee);padding:14px;border-radius:14px;margin:14px 0}
  input,select,button{box-sizing:border-box;width:100%;padding:11px;margin:5px 0;border-radius:9px;border:1px solid #999;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}
  button{background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff);border:0;font-weight:600}
  button.secondary{background:transparent;color:var(--tg-theme-text-color,#111);border:1px solid #999}
  .person{display:flex;gap:10px;align-items:center;padding:11px 0;border-bottom:1px solid #9996}.person:last-child{border:0}
  .person.frozen{opacity:.52;filter:grayscale(1)}.person input{width:20px;height:20px;margin:0;flex:none}
  .person .meta{flex:1;min-width:0}.status{color:#36a9df;font-size:12px;font-weight:700}.active{color:#259b62}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.grid label{font-size:12px}.grid input{margin-top:4px}
  .toolbar{display:flex;gap:8px}.toolbar button{flex:1}.stats{font-size:14px;line-height:1.8}
  .perm{display:block;margin:8px 0}.perm input{width:auto}.person button{width:auto}
  </style></head><body>
  <h1>InterModels</h1><div class="muted">Рабочая панель директора</div>
  <section class="panel"><h2>Ежемесячное обновление</h2><div id="refreshStats" class="stats">Загрузка статистики…</div>
  <button id="refreshAll">Обновить Comp</button><div class="muted">Будут поставлены в очередь композитки моделей, обновивших параметры в последней кампании.</div></section>
  <section class="panel"><h2>База моделей</h2><input id="search" placeholder="Поиск по имени или фамилии">
  <select id="filter"><option value="all">Все модели</option><option value="active">Активные</option><option value="frozen">Замороженные</option></select>
  <div class="toolbar"><button id="selectVisible" class="secondary">Выбрать видимые</button><button id="clearSelection" class="secondary">Снять выбор</button></div>
  <div id="models">Загрузка…</div><div class="muted" id="selectionCount">Выбрано: 0</div>
  <button id="refreshSelected">Обновить Comp выбранных</button></section>
  <section class="panel"><h2>Расписание обновления</h2><div class="muted">Кампания запускается ежемесячно в выбранный день. Срок для моделей — 48 часов. Расписание применяется к следующим кампаниям.</div>
  <div class="grid"><label>День месяца<input id="cycleDay" type="number" min="1" max="28" value="1"></label><label>Часовой пояс<input id="timezone" value="UTC" placeholder="Europe/Amsterdam"></label>
  <label>День 1 · утро<input id="time1" type="time" value="09:00"></label><label>День 1 · вечер<input id="time2" type="time" value="20:00"></label>
  <label>День 2 · утро<input id="time3" type="time" value="09:00"></label><label>День 2 · вечер<input id="time4" type="time" value="20:00"></label></div>
  <button id="saveSettings">Сохранить расписание</button></section>
  <section class="panel"><h2>Управление доступом</h2><h3>Выдать доступ</h3><input id="uid" inputmode="numeric" placeholder="Telegram ID помощника"><input id="name" placeholder="Имя (необязательно)">
  <select id="role"><option value="helper">Помощник</option><option value="viewer">Наблюдатель</option></select>
  <div id="perms"><label class="perm"><input type="checkbox" value="profile.view" checked> Просмотр анкет</label><label class="perm"><input type="checkbox" value="profile.edit"> Редактирование анкет</label><label class="perm"><input type="checkbox" value="photos.manage"> Управление фотографиями</label><label class="perm"><input type="checkbox" value="composite.generate"> Создание композиток</label><label class="perm"><input type="checkbox" value="requests.manage"> Решение заявок</label></div>
  <button id="grant">Выдать права</button><h3>Действующие доступы</h3><div id="staff">Загрузка…</div></section><div id="status" class="muted"></div>
  <script>
  const tg=window.Telegram?.WebApp;tg?.ready();tg?.expand();const initData=tg?.initData||'';const st=document.getElementById('status');let models=[];let selected=new Set();
  async function api(m,p,b){const r=await fetch(p,{method:m,headers:{Authorization:'tma '+initData,'Content-Type':'application/json'},...(b?{body:JSON.stringify(b)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'Ошибка');return d}
  function updateSelection(){document.getElementById('selectionCount').textContent='Выбрано: '+selected.size}
  function renderModels(){const root=document.getElementById('models');root.innerHTML='';const q=document.getElementById('search').value.trim().toLocaleLowerCase('ru');const filter=document.getElementById('filter').value;const visible=models.filter(m=>(m.first_name+' '+m.last_name).toLocaleLowerCase('ru').includes(q)&&(filter==='all'||m.lifecycle_status===filter));if(!visible.length){root.textContent='Модели не найдены.';return}
  for(const m of visible){const row=document.createElement('label');row.className='person'+(m.lifecycle_status==='frozen'?' frozen':'');const cb=document.createElement('input');cb.type='checkbox';cb.checked=selected.has(m.id);cb.disabled=m.lifecycle_status!=='active';cb.onchange=()=>{cb.checked?selected.add(m.id):selected.delete(m.id);updateSelection()};const meta=document.createElement('div');meta.className='meta';const name=document.createElement('strong');name.textContent=m.first_name+' '+m.last_name;const line=document.createElement('div');line.className=m.lifecycle_status==='frozen'?'status':'muted';line.textContent=m.lifecycle_status==='frozen'?'Заморожен':'Активна анкета';meta.append(name,line);row.append(cb,meta);root.append(row)}updateSelection()}
  async function loadModels(){try{const d=await api('GET','/api/director/models');models=d.models;renderModels()}catch(e){document.getElementById('models').textContent=e.message}}
  async function loadStats(){try{const d=await api('GET','/api/director/refresh-status');const c=d.campaign;if(!c){document.getElementById('refreshStats').textContent='Кампания ещё не запускалась.';return}document.getElementById('refreshStats').textContent='Моделей: '+c.total+' · Обновлено: '+c.updated+' · Ожидают: '+c.pending+' · Заморожено: '+c.frozen+' · Comp опубликовано: '+c.published+' · Ошибок: '+c.failed}catch(e){document.getElementById('refreshStats').textContent=e.message}}
  async function queue(ids){try{const d=await api('POST','/api/director/composites',{model_ids:ids});st.textContent='В очередь добавлено композиток: '+d.queued;await loadStats()}catch(e){st.textContent=e.message}}
  document.getElementById('search').oninput=renderModels;document.getElementById('filter').onchange=renderModels;
  document.getElementById('selectVisible').onclick=()=>{const q=document.getElementById('search').value.trim().toLocaleLowerCase('ru'),f=document.getElementById('filter').value;for(const m of models)if(m.lifecycle_status==='active'&&(m.first_name+' '+m.last_name).toLocaleLowerCase('ru').includes(q)&&(f==='all'||m.lifecycle_status===f))selected.add(m.id);renderModels()};
  document.getElementById('clearSelection').onclick=()=>{selected.clear();renderModels()};
  document.getElementById('refreshSelected').onclick=()=>selected.size?queue([...selected]):st.textContent='Сначала выберите активные модели.';document.getElementById('refreshAll').onclick=()=>queue([]);
  document.getElementById('saveSettings').onclick=async()=>{try{const body={cycle_day:Number(document.getElementById('cycleDay').value),timezone:document.getElementById('timezone').value.trim(),reminder_times:[1,2,3,4].map(i=>document.getElementById('time'+i).value)};await api('PUT','/api/director/refresh-settings',body);st.textContent='Расписание сохранено.'}catch(e){st.textContent=e.message}};
  async function loadSettings(){try{const d=await api('GET','/api/director/refresh-settings');const x=d.settings;document.getElementById('cycleDay').value=x.cycle_day;document.getElementById('timezone').value=x.timezone;x.reminder_times.forEach((v,i)=>document.getElementById('time'+(i+1)).value=v)}catch(e){st.textContent=e.message}}
  async function loadStaff(){try{const d=await api('GET','/api/director/staff');const root=document.getElementById('staff');root.innerHTML='';if(!d.staff.length){root.textContent='Помощники пока не добавлены.';return}for(const p of d.staff){const el=document.createElement('div');el.className='person';const title=document.createElement('strong');title.textContent=(p.display_name||'Без имени')+' · '+p.telegram_user_id;const info=document.createElement('div');info.className='muted';info.textContent=p.role+' · '+p.permissions.join(', ');const btn=document.createElement('button');btn.textContent='Отозвать';btn.onclick=async()=>{try{await api('DELETE','/api/director/staff?telegram_user_id='+encodeURIComponent(p.telegram_user_id));await loadStaff()}catch(e){st.textContent=e.message}};el.append(title,info,btn);root.append(el)}}catch(e){document.getElementById('staff').textContent=e.message}}
  document.getElementById('grant').onclick=async()=>{try{const id=document.getElementById('uid').value.trim(),permissions=[...document.querySelectorAll('#perms input:checked')].map(x=>x.value);await api('POST','/api/director/staff',{telegram_user_id:id,display_name:document.getElementById('name').value.trim(),role:document.getElementById('role').value,permissions});st.textContent='Доступ сохранён.';document.getElementById('uid').value='';await loadStaff()}catch(e){st.textContent=e.message}};
  loadModels();loadStats();loadSettings();loadStaff();
  </script></body></html>`;
  return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'self' https://telegram.org; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org"}});
}
async function handleDirectorApi(request: Request, env: Env, url: URL): Promise<Response> {
  const actor = await miniAppActor(request, env);
  if (!actor) return json({ error: "Недействительная или устаревшая авторизация Telegram." }, 401);
  const path = url.pathname;
  const isAdmin = actor.id === env.OWNER_TELEGRAM_ID || actor.id === env.DIRECTOR_TELEGRAM_ID;
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
      "SELECT id,cycle_key,starts_at,deadline_at,status FROM profile_refresh_campaigns ORDER BY starts_at DESC LIMIT 1",
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
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body: any; try { body = await request.json(); } catch { return json({ error: "Некорректный JSON." }, 400); }
    if (body?.model_ids !== undefined && (!Array.isArray(body.model_ids) || body.model_ids.length > 100 || body.model_ids.some((id: unknown) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,50}$/.test(id)))) {
      return json({ error: "Некорректный список моделей." }, 400);
    }
    try {
      const result = await queueCompositeRefresh(env, Array.isArray(body?.model_ids) ? body.model_ids : null, actor.id);
      return json({ ok: true, ...result });
    } catch (error) { return json({ error: error instanceof Error ? error.message : "Не удалось поставить композитки в очередь." }, 409); }
  }
  if (path !== "/api/director/staff") return json({ error: "Not found" }, 404);
  if (!(await actorHasPermission(env, actor.id, "staff.manage"))) return json({ error: "Недостаточно прав." }, 403);
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT telegram_user_id,display_name,role,permissions_json,is_active FROM agency_staff_access ORDER BY created_at DESC").all<{ telegram_user_id: string; display_name: string | null; role: string; permissions_json: string; is_active: number }>();
    const staff = (result.results ?? []).map((row) => {
      let permissions: string[] = [];
      try { permissions = Object.keys(JSON.parse(row.permissions_json)).filter((key) => STAFF_PERMISSIONS.includes(key as StaffPermission)); } catch {}
      return { telegram_user_id: row.telegram_user_id, display_name: row.display_name, role: row.role, permissions, is_active: row.is_active === 1 };
    });
    return json({ ok: true, staff });
  }
  if (request.method === "POST") {
    let body: any; try { body = await request.json(); } catch { return json({ error: "Некорректный JSON." }, 400); }
    const id = String(body?.telegram_user_id ?? "").trim(), role = body?.role;
    const displayName = typeof body?.display_name === "string" ? body.display_name.trim().slice(0, 100) : null;
    const permissions: string[] = Array.isArray(body?.permissions) ? Array.from(new Set<string>(body.permissions.filter((p: unknown) => typeof p === "string").map((p: unknown) => String(p)))) : [];
    if (!/^[0-9]{5,20}$/.test(id) || !["helper", "viewer"].includes(role) || permissions.some((p) => !STAFF_PERMISSIONS.includes(p as StaffPermission) || p === "staff.manage")) return json({ error: "Проверьте Telegram ID, роль и разрешения." }, 400);
    if (id === env.OWNER_TELEGRAM_ID || id === env.DIRECTOR_TELEGRAM_ID) return json({ error: "Нельзя менять доступ владельца или директора." }, 400);
    if (role === "viewer" && permissions.some((p) => p !== "profile.view")) return json({ error: "Наблюдателю доступен только просмотр." }, 400);
    await env.DB.prepare("INSERT INTO agency_staff_access(telegram_user_id,display_name,role,permissions_json,granted_by) VALUES(?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,permissions_json=excluded.permissions_json,is_active=1,granted_by=excluded.granted_by,updated_at=CURRENT_TIMESTAMP").bind(id, displayName, role, JSON.stringify(Object.fromEntries(permissions.map((p) => [p, true]))), actor.id).run();
    await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'staff.grant', ?)").bind(randomId(), actor.id, JSON.stringify({ telegram_user_id: id, role, permissions })).run();
    return json({ ok: true });
  }
  if (request.method === "DELETE") {
    const id = (url.searchParams.get("telegram_user_id") ?? "").trim();
    if (!/^[0-9]{5,20}$/.test(id) || id === env.OWNER_TELEGRAM_ID || id === env.DIRECTOR_TELEGRAM_ID) return json({ error: "Некорректный или защищённый Telegram ID." }, 400);
    await env.DB.prepare("UPDATE agency_staff_access SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE telegram_user_id=?").bind(id).run();
    await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'staff.revoke', ?)").bind(randomId(), actor.id, JSON.stringify({ telegram_user_id: id })).run();
    return json({ ok: true });
  }
  return json({ error: "Method not allowed" }, 405);
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
async function queueCompositeRefresh(env: Env, modelIds: string[] | null, actorId: string): Promise<{ campaignId: string; queued: number }> {
  const campaign = await env.DB.prepare("SELECT id FROM profile_refresh_campaigns ORDER BY starts_at DESC LIMIT 1").first<{ id: string }>();
  if (!campaign) throw new Error("Ежемесячная кампания обновления ещё не запускалась.");
  let rows: { model_id: string }[];
  if (modelIds?.length) {
    const ids = Array.from(new Set(modelIds)).slice(0, 100);
    const placeholders = ids.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT r.model_id FROM profile_refresh_members r JOIN models m ON m.id = r.model_id
       WHERE r.campaign_id = ? AND r.status = 'updated' AND m.is_active = 1
         AND m.lifecycle_status = 'active' AND r.model_id IN (${placeholders})`,
    ).bind(campaign.id, ...ids).all<{ model_id: string }>();
    rows = result.results ?? [];
  } else {
    const result = await env.DB.prepare(
      `SELECT r.model_id FROM profile_refresh_members r JOIN models m ON m.id = r.model_id
       WHERE r.campaign_id = ? AND r.status = 'updated' AND m.is_active = 1
         AND m.lifecycle_status = 'active'`,
    ).bind(campaign.id).all<{ model_id: string }>();
    rows = result.results ?? [];
  }
  for (const row of rows) {
    await env.DB.prepare(
      `INSERT INTO composite_refresh_jobs(campaign_id,model_id,status,attempts,last_error,updated_at)
       VALUES(?,?,'pending',0,NULL,CURRENT_TIMESTAMP)
       ON CONFLICT(campaign_id,model_id) DO UPDATE SET status='pending',last_error=NULL,updated_at=CURRENT_TIMESTAMP`,
    ).bind(campaign.id, row.model_id).run();
  }
  await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'composite.refresh.queued', ?)")
    .bind(randomId(), actorId, JSON.stringify({ campaign_id: campaign.id, model_ids: rows.map((row) => row.model_id) })).run();
  return { campaignId: campaign.id, queued: rows.length };
}
async function publishCompositeModel(env: Env, campaignId: string, modelId: string): Promise<void> {
  const topic = await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id = 1")
    .first<{ chat_id: string; thread_id: number }>();
  if (!topic) throw new Error("Тема «КОМПОЗИТКИ» не подключена.");
  const model = await env.DB.prepare(
    `SELECT m.id,m.first_name,m.last_name,p.height_cm,p.bust_cm,p.waist_cm,p.hips_cm,
      p.clothing_size,p.shoe_size,p.hair_color,p.eye_color
     FROM models m LEFT JOIN model_profiles p ON p.model_id=m.id
     WHERE m.id=? AND m.is_active=1 AND m.lifecycle_status='active'`,
  ).bind(modelId).first<SecretaryModelRow>();
  if (!model) throw new Error("Модель не найдена в активной базе.");
  const result = await env.DB.prepare("SELECT position,telegram_file_id FROM model_telegram_photos WHERE model_id=? ORDER BY position")
    .bind(modelId).all<{ position: number; telegram_file_id: string }>();
  const photos = result.results ?? [];
  if (photos.length !== 4 || photos.some((photo, index) => photo.position !== index + 1)) {
    throw new Error("Для модели не загружены все четыре фотографии.");
  }
  const png = await renderCompositePng(env, model, photos.map((photo) => photo.telegram_file_id));
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
  await env.DB.prepare("UPDATE composite_refresh_jobs SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE status='processing' AND updated_at < datetime('now','-10 minutes')").run();
  const jobs = await env.DB.prepare(
    `SELECT campaign_id,model_id FROM composite_refresh_jobs
     WHERE status='pending' ORDER BY created_at LIMIT 2`,
  ).all<{ campaign_id: string; model_id: string }>();
  for (const job of jobs.results ?? []) {
    const claim = await env.DB.prepare(
      "UPDATE composite_refresh_jobs SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND model_id=? AND status='pending'",
    ).bind(job.campaign_id, job.model_id).run();
    if (!claim.meta.changes) continue;
    try {
      await publishCompositeModel(env, job.campaign_id, job.model_id);
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
  if (now.getTime() < Date.parse(startsAt)) return;
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
      await env.DB.prepare("UPDATE profile_refresh_campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'")
        .bind(campaign.id).run();
      await sendDirector(env, "Ежемесячное обновление параметров завершено.\nЗаморожено моделей: " + (late.results?.length ?? 0) + ".");
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
    const secret = isModel ? env.MODEL_WEBHOOK_SECRET : isDirector ? env.DIRECTOR_WEBHOOK_SECRET : env.SECRETARY_WEBHOOK_SECRET;
    if (!secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return json({ error: "Unauthorized" }, 401);
    let update: TelegramUpdate;
    try { update = await request.json() as TelegramUpdate; }
    catch { return json({ error: "Invalid JSON" }, 400); }
    try {
      const isCompositeUpdate = isSecretary && (
        /^\/comp(?:@\w+)?\s+/i.test(update.message?.text ?? "") ||
        (update.callback_query?.data ?? "").startsWith("csel:")
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
      return json({ ok: true });
    } catch (error) {
      console.error("Webhook handler failed", error);
      return json({ ok: false }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([processRefreshCampaigns(env), processCompositeRefreshJobs(env)]).then(() => undefined));
  },
};
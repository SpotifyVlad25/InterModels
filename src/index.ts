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
  COMPOSITE_RENDERER_URL?: string;
  COMPOSITE_RENDERER_TOKEN?: string;
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
  id: string; first_name: string; last_name: string; phone: string | null;
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
  await env.DB.prepare("UPDATE secretary_operations SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('running','publishing')")
    .bind(status, operationId).run();
}
async function setSecretaryOperationStatusMessage(env: Env, operationId: string, messageId: number | undefined): Promise<void> {
  if (!messageId) return;
  await env.DB.prepare("UPDATE secretary_operations SET status_message_id=? WHERE id=? AND status='running'")
    .bind(messageId, operationId).run();
}
async function recordSecretaryOperationResult(env: Env, operationId: string, chatId: number, messageId: number): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE secretary_operations SET result_chat_id=?,result_message_id=? WHERE id=? AND status='running'",
  ).bind(String(chatId), messageId, operationId).run();
  return (result.meta?.changes ?? 0) > 0;
}
async function claimSecretaryOperationPublication(env: Env, operationId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE secretary_operations SET status='publishing',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'",
  ).bind(operationId).run();
  return (result.meta?.changes ?? 0) > 0;
}
async function deleteTelegramMessage(env: Env, chatId: number | string, messageId: number | undefined, context: string): Promise<void> {
  if (!messageId) return;
  try {
    await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (error) {
    console.warn("Unable to clean up Telegram message", { context, chatId, messageId, error: compositeErrorText(error) });
  }
}
async function trackSecretaryPhotoUploadMessages(
  env: Env, chatId: number, threadId: number, uploaderId: string,
  additions: { commandId?: number; promptId?: number; photoIds?: number[]; botIds?: number[] } = {},
): Promise<void> {
  const key = { chat: String(chatId), thread: threadId, uploader: uploaderId };
  const current = await env.DB.prepare(
    "SELECT command_message_id,prompt_message_id,photo_message_ids_json,bot_message_ids_json FROM secretary_photo_upload_sessions WHERE chat_id=? AND thread_id=? AND uploader_id=?",
  ).bind(key.chat,key.thread,key.uploader).first<{command_message_id:number|null;prompt_message_id:number|null;photo_message_ids_json:string;bot_message_ids_json:string}>();
  const photos = new Set<number>(JSON.parse(current?.photo_message_ids_json ?? "[]"));
  const bots = new Set<number>(JSON.parse(current?.bot_message_ids_json ?? "[]"));
  for (const id of additions.photoIds ?? []) if (Number.isSafeInteger(id) && id>0) photos.add(id);
  for (const id of additions.botIds ?? []) if (Number.isSafeInteger(id) && id>0) bots.add(id);
  await env.DB.prepare(
    `INSERT INTO secretary_photo_upload_sessions(chat_id,thread_id,uploader_id,command_message_id,prompt_message_id,photo_message_ids_json,bot_message_ids_json,updated_at)
     VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id,thread_id,uploader_id) DO UPDATE SET
       command_message_id=COALESCE(excluded.command_message_id,secretary_photo_upload_sessions.command_message_id),
       prompt_message_id=COALESCE(excluded.prompt_message_id,secretary_photo_upload_sessions.prompt_message_id),
       photo_message_ids_json=excluded.photo_message_ids_json,
       bot_message_ids_json=excluded.bot_message_ids_json,updated_at=CURRENT_TIMESTAMP`,
  ).bind(key.chat,key.thread,key.uploader,additions.commandId ?? current?.command_message_id ?? null,
    additions.promptId ?? current?.prompt_message_id ?? null,JSON.stringify([...photos]),JSON.stringify([...bots])).run();
}
async function cleanupSecretaryPhotoUploadMessages(env: Env, chatId: number, threadId: number, uploaderId: string, extraIds: number[] = []): Promise<void> {
  const session = await env.DB.prepare(
    "SELECT command_message_id,prompt_message_id,progress_message_id,photo_message_ids_json,bot_message_ids_json FROM secretary_photo_upload_sessions WHERE chat_id=? AND thread_id=? AND uploader_id=?",
  ).bind(String(chatId),threadId,uploaderId).first<{command_message_id:number|null;prompt_message_id:number|null;progress_message_id:number|null;photo_message_ids_json:string;bot_message_ids_json:string}>();
  const ids = new Set<number>(extraIds);
  for (const id of [session?.command_message_id,session?.prompt_message_id,session?.progress_message_id]) if (id) ids.add(id);
  for (const field of [session?.photo_message_ids_json,session?.bot_message_ids_json]) {
    try { for (const id of JSON.parse(field ?? "[]") as number[]) if (Number.isSafeInteger(id) && id>0) ids.add(id); } catch {}
  }
  for (const id of ids) await deleteTelegramMessage(env,String(chatId),id,"MODEL BANK completed upload cleanup");
  await env.DB.prepare("DELETE FROM secretary_photo_upload_sessions WHERE chat_id=? AND thread_id=? AND uploader_id=?")
    .bind(String(chatId),threadId,uploaderId).run();
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
      reply_markup: { inline_keyboard: keyboard },
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
  if (step) await sendModel(env, chatId, "Продолжим заполнение анкеты.\n\n" + step.prompt, threadId);
  else if (model?.lifecycle_status === "frozen") await sendModel(env, chatId, "🥶\n\nУпс, ваша анкета заморожена и временно не отображается в активной базе.\nОтправьте /profile, чтобы обновить параметры и восстановить доступ.", threadId);
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
  if (!(await canManageRequests(env, String(callback.from.id)))) {
    await answerCallback(env, callback, "Недостаточно прав.", true); return;
  }
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
    await env.DB.prepare("DELETE FROM secretary_composite_input_pending WHERE chat_id=? AND thread_id=? AND user_id=?")
      .bind(String(msg.chat.id), msg.message_thread_id, String(callback.from.id)).run();
    const prompt = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
      text: "Выберите стиль композитки:",
      reply_markup: { inline_keyboard: [[
        { text: "Basic", callback_data: "comp_style:basic" },
        { text: "Fashion", callback_data: "comp_style:fashion" },
      ]] },
    });
    await env.DB.prepare(
      "INSERT INTO secretary_composite_request_pending(chat_id,thread_id,user_id,stage,style,language,names_text,command_message_id,prompt_message_id) VALUES(?,?,?,'style',NULL,NULL,NULL,NULL,?) ON CONFLICT(chat_id,thread_id,user_id) DO UPDATE SET stage='style',style=NULL,language=NULL,names_text=NULL,command_message_id=NULL,prompt_message_id=excluded.prompt_message_id,created_at=CURRENT_TIMESTAMP",
    ).bind(String(msg.chat.id), msg.message_thread_id, String(callback.from.id), prompt.result?.message_id ?? null).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Выберите стиль и язык." });
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
  const replyMarkup = { keyboard: [[{ text: "➕ Добавить модель" }]], resize_keyboard: true, is_persistent: true };
  const sendDirectorMenu = async (text: string) => telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id,
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    text,
    reply_markup: replyMarkup,
  });
  if (message.text?.startsWith("/start")) {
    await saveTopic(env, "director", message);
    if (message.chat.type === "private") {
      await telegram(env.DIRECTOR_BOT_TOKEN, "setChatMenuButton", {
        chat_id: message.chat.id,
        menu_button: { type: "web_app", text: "Кабинет", web_app: { url: "https://intermodels.spotify-vlad25.workers.dev/app" } },
      });
    }
    await sendDirectorMenu("InterModels Director подключён. У вас полный доступ.\n\nЧтобы добавить одну или несколько моделей в базу, нажмите «➕ Добавить модель».");
    return;
  }
  if (message.text?.startsWith("/help")) {
    await sendDirectorMenu("Команды:\n/start — подключить бота\n/help — помощь\n\n➕ Добавить модель — создать записи в базе по имени и фамилии.");
    return;
  }
  if (message.text === "➕ Добавить модель" || message.text === "Добавить модель") {
    await env.DB.prepare(
      "INSERT INTO bot_sessions (telegram_user_id,state,data_json,updated_at) VALUES (?,'director_add_model','{}',CURRENT_TIMESTAMP) ON CONFLICT(telegram_user_id) DO UPDATE SET state='director_add_model',data_json='{}',updated_at=CURRENT_TIMESTAMP",
    ).bind(senderId).run();
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: "Отправьте имя и фамилию одной модели.\n\nМожно добавить сразу несколько: каждую пару «имя фамилия» укажите с новой строки.",
    });
    return;
  }
  const directorSession = await env.DB.prepare("SELECT state FROM bot_sessions WHERE telegram_user_id=?")
    .bind(senderId).first<{state:string}>();
  if (directorSession?.state !== "director_add_model" || !message.text) return;
  const lines = message.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "Не вижу имён. Отправьте имя и фамилию, по одной модели на строку." });
    return;
  }
  const invalid: string[] = [];
  const entries: Array<{firstName:string;lastName:string;label:string}> = [];
  for (const line of lines) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || normalizeName(line).length < 3) { invalid.push(line); continue; }
    entries.push({ firstName: parts[0], lastName: parts.slice(1).join(" "), label: line });
  }
  if (invalid.length) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "Не удалось распознать имя и фамилию в строках:\n" + invalid.map((line) => "• " + line).join("\n") + "\n\nИсправьте эти строки и отправьте их ещё раз. Остальные записи пока не создавались.",
    });
    return;
  }
  const existingResult = await env.DB.prepare("SELECT first_name,last_name FROM models").all<{first_name:string;last_name:string}>();
  const existing = new Set((existingResult.results ?? []).map((row) => normalizeName(row.first_name + " " + row.last_name)));
  const created: string[] = [], duplicates: string[] = [];
  for (const entry of entries) {
    const key = normalizeName(entry.firstName + " " + entry.lastName);
    if (existing.has(key)) { duplicates.push(entry.label); continue; }
    await env.DB.prepare(
      "INSERT INTO models (id,first_name,last_name,is_active,lifecycle_status) VALUES (?,?,?,1,'active')",
    ).bind(randomId(), entry.firstName, entry.lastName).run();
    existing.add(key);
    created.push(entry.label);
  }
  await env.DB.prepare("UPDATE bot_sessions SET state='director_idle',data_json='{}',updated_at=CURRENT_TIMESTAMP WHERE telegram_user_id=?")
    .bind(senderId).run();
  const linesOut = [
    "Готово. Записи добавлены в базу InterModels.",
    created.length ? "\nСоздано:\n" + created.map((name) => "• " + name).join("\n") : "",
    duplicates.length ? "\nУже были в базе (повторно не создавал):\n" + duplicates.map((name) => "• " + name).join("\n") : "",
    "\nТеперь модели могут открыть @InterModels_model_bot, отправить /start и зарегистрироваться по своему имени и фамилии. Подключение по-прежнему подтверждается директором.",
  ].filter(Boolean).join("");
  await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id,
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    text: linesOut,
    reply_markup: replyMarkup,
  });
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
    `SELECT m.id, m.first_name, m.last_name, m.phone,
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
  // Downscale before Resvg decodes the embedded image. Keep the full frame and
  // original aspect ratio; scale-down never crops or stretches the source.
  // The 1800px bound is ample for the 1600x2844 output canvas and avoids
  // excessive WASM memory use with high-resolution originals.
  const response = await fetch(imageUrl, {
    cf: { image: { width: 1800, height: 1800, fit: "scale-down", format: "jpeg", quality: 88 } },
  });
  if (!response.ok) throw new Error("Unable to download/resize Telegram image (HTTP " + response.status + ")");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Optimized image size is invalid (maximum 8 MB)");
  const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mime !== "image/jpeg") throw new Error("Cloudflare image optimization returned an unsupported format: " + (mime || "unknown"));
  return "data:image/jpeg;base64," + bytesToBase64(bytes);
}
function imageDimensions(data: string): { width: number; height: number } {
  const comma = data.indexOf(",");
  if (!data.startsWith("data:") || comma < 0) throw new Error("Invalid composite image data URI");
  const binary = atob(data.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const u16 = (p: number) => (bytes[p] << 8) | bytes[p + 1];
  const u24le = (p: number) => bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
  const u32le = (p: number) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { width: u32le(16), height: u32le(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2;
    while (p + 4 < bytes.length) {
      if (bytes[p] !== 0xff) { p++; continue; }
      const marker = bytes[p + 1]; p += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > bytes.length) break;
      const length = u16(p);
      if (length < 2 || p + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { height: u16(p + 3), width: u16(p + 5) };
      p += length;
    }
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === "VP8X" && bytes.length >= 30) return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === "VP8 " && bytes.length >= 30) return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
    if (chunk === "VP8L" && bytes.length >= 25) {
      const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
      return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
    }
  }
  throw new Error("Unable to read original photo dimensions");
}
function transliterateCompositeName(value: string): string {
  const map: Record<string, string> = {
    а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"yo",ж:"zh",з:"z",и:"i",й:"y",
    к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",
    х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"shch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya",
  };
  return value.replace(/[А-ЯЁа-яё]/g, (char) => {
    const result = map[char.toLowerCase()] ?? char;
    return char === char.toUpperCase() ? result.toUpperCase() : result;
  });
}
function translateCompositeColor(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[\s_]+/g, " ");
  const phrases: Record<string, string> = {
    "русые":"Dark Blonde","светло-русые":"Light Blonde","темно-русые":"Dark Blonde",
    "темно русые":"Dark Blonde","блонд":"Blonde","блондин":"Blonde","блондинка":"Blonde",
    "светлые":"Blonde","платиновый блонд":"Platinum Blonde","платиновый":"Platinum Blonde",
    "каштановые":"Chestnut","каштановый":"Chestnut","шатен":"Brown","шатенка":"Brown",
    "брюнет":"Dark Brown","брюнетка":"Dark Brown","темные":"Dark Brown","черные":"Black",
    "черный":"Black","коричневые":"Brown","коричневый":"Brown","рыжие":"Red",
    "рыжий":"Red","медные":"Copper","седые":"Grey","седой":"Grey","серые":"Grey",
    "белые":"White","голубые":"Blue","голубой":"Blue","синие":"Blue","синий":"Blue",
    "карие":"Brown","карий":"Brown","зеленые":"Green","зеленый":"Green",
    "серо-голубые":"Blue-Grey","серо голубые":"Blue-Grey","серо-зеленые":"Grey-Green",
    "серо зеленые":"Grey-Green","голубо-зеленые":"Blue-Green","голубо зеленые":"Blue-Green",
    "разноцветные":"Multicoloured","ореховые":"Hazel","янтарные":"Amber",
  };
  if (phrases[normalized]) return phrases[normalized];
  const words: Record<string, string> = {
    "светло":"Light","темно":"Dark","русый":"Dark Blonde","русая":"Dark Blonde",
    "русые":"Dark Blonde","блонд":"Blonde","каштановый":"Chestnut","каштановая":"Chestnut",
    "карий":"Brown","карие":"Brown","голубой":"Blue","голубые":"Blue","синий":"Blue",
    "синие":"Blue","зеленый":"Green","зеленые":"Green","серый":"Grey","серые":"Grey",
    "черный":"Black","черные":"Black","коричневый":"Brown","коричневые":"Brown",
    "рыжий":"Red","рыжие":"Red","медный":"Copper","медные":"Copper","седой":"Grey",
    "седые":"Grey","белый":"White","белые":"White",
  };
  return normalized.split(" ").map((word) => words[word] ?? transliterateCompositeName(word)).join(" ");
}
function compositeSvg(model: SecretaryModelRow, photos: string[], language: "ru" | "en" = "ru"): string {
  if (photos.length !== 7) throw new Error("A composite requires exactly seven original photos");
  const firstName = (model.first_name || "").trim();
  const surnameInitial = (model.last_name || "").trim().charAt(0);
  const displayFirstName = language === "en" ? transliterateCompositeName(firstName) : firstName;
  const displaySurnameInitial = language === "en" ? transliterateCompositeName(surnameInitial) : surnameInitial;
  const rawName = (displayFirstName + (displaySurnameInitial ? " " + displaySurnameInitial + "." : "")).toUpperCase();
  const labels = language === "en"
    ? ["HEIGHT", "BUST", "WAIST", "HIPS", "HAIR", "EYES", "CLOTHING", "SHOES"]
    : ["РОСТ", "ГРУДЬ", "ТАЛИЯ", "БЁДРА", "ВОЛОСЫ", "ГЛАЗА", "ОДЕЖДА", "ОБУВЬ"];
  const unit = language === "en" ? " CM" : " СМ";
  const values = [
    model.height_cm != null ? String(model.height_cm) + unit : null,
    model.bust_cm != null ? String(model.bust_cm) + unit : null,
    model.waist_cm != null ? String(model.waist_cm) + unit : null,
    model.hips_cm != null ? String(model.hips_cm) + unit : null,
    language === "en" ? translateCompositeColor(model.hair_color) : model.hair_color || null,
    language === "en" ? translateCompositeColor(model.eye_color) : model.eye_color || null,
    model.clothing_size || null, model.shoe_size || null,
  ];
  // Fixed InterModels comp-card canvas. Photo frames are never cropped or
  // distorted: SVG "meet" contains each full source image inside its cell.
  const canvasW = 1938, canvasH = 1364;
  const mainW = 909, rightW = 1029;
  // The right column remains split exactly 75% gallery / 25% information.
  const galleryH = canvasH * 0.75, infoH = canvasH * 0.25;
  const cellW = 343, firstRowH = galleryH / 2, secondRowH = galleryH / 2;
  // The model name is overlaid on the main photo; parameters use 3/4 of the
  // information panel and the existing contact footer keeps its 1/4.
  const detailsTop = galleryH, footerH = infoH / 4, detailsBandH = infoH - footerH;
  const footerTop = detailsTop + detailsBandH;
  const mainPhoto = `<image href="${photos[0]}" x="0" y="0" width="${mainW}" height="${canvasH}" preserveAspectRatio="xMidYMid meet"/>`;
  const gallery = photos.slice(1).map((data, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const x = mainW + col * cellW;
    const y = row === 0 ? 0 : firstRowH;
    const height = row === 0 ? firstRowH : secondRowH;
    return `<image href="${data}" x="${x}" y="${y}" width="${cellW}" height="${height}" preserveAspectRatio="xMidYMid meet"/>`;
  }).join("");
  const infoScale = infoH / 317;
  const tabWidth = Math.min(mainW - 96, Math.max(360, rawName.length * 38 + 112));
  const tabHeight = 112;
  const tabX = (mainW - tabWidth) / 2;
  const tabY = canvasH - tabHeight;
  const nameSize = Math.min(76, (tabWidth - 64) / Math.max(1, rawName.length * 0.68));
  const parameterColumn = (startIndex: number, x: number) => values.slice(startIndex, startIndex + 4).map((value, index) => {
    if (!value) return "";
    const rowStep = detailsBandH / 4 * 0.8;
    const y = detailsTop + detailsBandH * 0.54 + (index - 1.5) * rowStep;
    const labelSize = 18 * infoScale;
    const valueSize = 24 * infoScale;
    return `<text x="${x}" y="${y}" class="parameter-label" font-size="${labelSize}">${escapeXml(labels[startIndex + index])}</text><text x="${x + 154 * infoScale}" y="${y}" class="parameter-value" font-size="${valueSize}">${escapeXml(value)}</text>`;
  }).join("");
  const leftColumnX = mainW + 52 * infoScale;
  const rightColumnX = mainW + rightW / 2 + 18 * infoScale;
  const contactX = mainW + 64 * infoScale;
  const websiteCenterX = mainW + rightW * 0.41;
  const logoRightX = canvasW - 28 * infoScale;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">
  <rect width="${canvasW}" height="${canvasH}" fill="#fff"/>
  ${mainPhoto}
  ${gallery}
  <path d="M ${tabX} ${canvasH} V ${tabY + 18} Q ${tabX} ${tabY} ${tabX + 18} ${tabY} H ${tabX + tabWidth - 18} Q ${tabX + tabWidth} ${tabY} ${tabX + tabWidth} ${tabY + 18} V ${canvasH} Z" fill="#fff"/>
  <text x="${mainW / 2}" y="${canvasH - 36}" text-anchor="middle" class="name" font-size="${nameSize}">${escapeXml(rawName)}</text>
  ${parameterColumn(0, leftColumnX)}
  ${parameterColumn(4, rightColumnX)}
  <line x1="${mainW}" y1="${footerTop}" x2="${canvasW}" y2="${footerTop}" class="separator"/>
  <text x="${contactX}" y="${footerTop + footerH * 0.62}" class="phone">+7 902 632-32-72</text>
  <text x="${websiteCenterX}" y="${footerTop + footerH * 0.62}" text-anchor="middle" class="website">inter-models.ru</text>
  <text x="${logoRightX}" y="${footerTop + footerH * 0.48}" text-anchor="end" class="brand">INTERMODELS</text>
  <text x="${logoRightX}" y="${footerTop + footerH * 0.79}" text-anchor="end" class="tagline">MODEL AGENCY</text>
  <style>
    text{font-family:"DejaVu Sans",Roboto,sans-serif;fill:#171717}
    .name{font-weight:800;letter-spacing:1px}
    .parameter-label{font-weight:700;letter-spacing:.4px;fill:#000}
    .parameter-value{font-weight:400}
    .phone{font-size:${25 * infoScale}px;font-weight:600;letter-spacing:.1px}
    .website{font-size:${24 * infoScale}px;font-weight:500}
    .brand{font-size:${42 * infoScale}px;font-weight:800;letter-spacing:${3 * infoScale}px}
    .tagline{font-size:${16 * infoScale}px;font-weight:400;letter-spacing:${4 * infoScale}px}
    .separator{stroke:#e5e5e5;stroke-width:2}
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
async function renderCompositePng(env: Env, model: SecretaryModelRow, fileIds: string[], onStage?: (stage: string) => Promise<void>, language: "ru" | "en" = "ru"): Promise<Uint8Array> {
  let stage = "init_wasm";
  try {
    await onStage?.("Подготовка графического движка");
    stage = "download_photos";
    await onStage?.("Загрузка 7 фотографий");
    const photoStartedAt = Date.now();
    const photos = await Promise.all(fileIds.map((id) => getSecretaryPhotoData(env, id)));
    const photoBytes = photos.map((photo) => Math.floor((photo.length * 3) / 4));
    console.info("Composite source photos downloaded", { modelId: model.id, photoBytes, totalPhotoBytes: photoBytes.reduce((sum, size) => sum + size, 0), elapsedMs: Date.now() - photoStartedAt });
    stage = "build_svg";
    await onStage?.("Сборка макета");
    const svg = compositeSvg(model, photos, language);
    console.info("Composite SVG assembled", { modelId: model.id, svgCharacters: svg.length });
    stage = "prepare_fonts";
    await onStage?.("Подготовка шрифтов");
    const fontBuffers = await Promise.all([compositeFontBuffer(robotoCyrillic), compositeFontBuffer(robotoLatin)]);
    if (fontBuffers.some((font) => font.byteLength < 4 || !((font[0] === 0x77 && font[1] === 0x4f && font[2] === 0x46 && font[3] === 0x32) || (font[0] === 0 && font[1] === 1 && font[2] === 0 && font[3] === 0) || (font[0] === 79 && font[1] === 84 && font[2] === 84 && font[3] === 79)))) {
      throw new Error("Roboto font asset has an unsupported or invalid signature");
    }
    stage = "create_renderer";
    await onStage?.("Создание рендерера Resvg");
    if (env.COMPOSITE_RENDERER_URL || env.COMPOSITE_RENDERER_TOKEN) {
      if (!env.COMPOSITE_RENDERER_URL || !env.COMPOSITE_RENDERER_TOKEN) {
        throw new Error("External composite renderer is partially configured; both URL and token are required");
      }
      stage = "external_render";
      await onStage?.("Рендеринг на выделенном сервере");
      const endpoint = env.COMPOSITE_RENDERER_URL.replace(/\/+$/, "") + "/render";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + env.COMPOSITE_RENDERER_TOKEN,
        },
        body: JSON.stringify({ svg }),
      });
      if (!response.ok) {
        const details = (await response.text()).slice(0, 1200);
        throw new Error("External renderer returned HTTP " + response.status + ": " + details);
      }
      const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (mime !== "image/png") throw new Error("External renderer returned unsupported content type: " + (mime || "unknown"));
      const png = new Uint8Array(await response.arrayBuffer());
      if (!png.length || png.length > 20 * 1024 * 1024) throw new Error("External renderer PNG size is invalid");
      return png;
    }
    await ensureResvg();
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

async function saveSecretaryPhotoSet(env:Env,modelId:string,photos:Array<{file_id:string;file_unique_id:string}>,senderId:string,chatId:number,threadId:number,style:"basic"|"fashion",operationId?:string):Promise<void>{
  await assertSecretaryOperationActive(env,operationId);if(photos.length!==7)throw new Error("Для сохранения нужны ровно семь фотографий.");
  const statements=operationId?[
    env.DB.prepare("DELETE FROM model_telegram_photo_sets WHERE model_id=? AND style=? AND EXISTS (SELECT 1 FROM secretary_operations WHERE id=? AND status='running')").bind(modelId,style,operationId),
    ...photos.map((photo,index)=>env.DB.prepare("INSERT INTO model_telegram_photo_sets(model_id,style,position,telegram_file_id,telegram_file_unique_id,uploaded_by,source_chat_id,source_thread_id) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM secretary_operations WHERE id=? AND status='running')").bind(modelId,style,index+1,photo.file_id,photo.file_unique_id,senderId,String(chatId),threadId,operationId)),
    env.DB.prepare("UPDATE secretary_operations SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'").bind(operationId),
  ]:[
    env.DB.prepare("DELETE FROM model_telegram_photo_sets WHERE model_id=? AND style=?").bind(modelId,style),
    ...photos.map((photo,index)=>env.DB.prepare("INSERT INTO model_telegram_photo_sets(model_id,style,position,telegram_file_id,telegram_file_unique_id,uploaded_by,source_chat_id,source_thread_id) VALUES(?,?,?,?,?,?,?,?)").bind(modelId,style,index+1,photo.file_id,photo.file_unique_id,senderId,String(chatId),threadId)),
  ];
  await env.DB.batch(statements);
  if(operationId){const state=await env.DB.prepare("SELECT status FROM secretary_operations WHERE id=?").bind(operationId).first<{status:string}>();if(state?.status!=="completed")throw new Error("SECRETARY_OPERATION_CANCELLED");}
}
async function removePreviousSecretaryPhotoDatabasePublication(env:Env,modelId:string,style:"basic"|"fashion"):Promise<void>{
  const previous=await env.DB.prepare("SELECT chat_id,message_ids_json FROM secretary_photo_database_publications WHERE model_id=? AND style=?").bind(modelId,style).first<{chat_id:string;message_ids_json:string}>();
  if(!previous)return;
  let ids:number[]=[];
  try{ids=JSON.parse(previous.message_ids_json) as number[];}catch{}
  for(const id of ids)if(Number.isSafeInteger(id)&&id>0)await deleteTelegramMessage(env,previous.chat_id,id,"replace old photo database album");
}
async function recordSecretaryPhotoDatabasePublication(env:Env,modelId:string,style:"basic"|"fashion",chatId:number|string,threadId:number,messageIds:number[]):Promise<void>{
  await removePreviousSecretaryPhotoDatabasePublication(env,modelId,style);
  await env.DB.prepare("INSERT INTO secretary_photo_database_publications(model_id,style,chat_id,thread_id,message_ids_json,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(model_id,style) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,message_ids_json=excluded.message_ids_json,updated_at=CURRENT_TIMESTAMP")
    .bind(modelId,style,String(chatId),threadId,JSON.stringify(messageIds)).run();
}
async function publishSecretaryPhotoSetToDatabase(env:Env,modelId:string,style:"basic"|"fashion",sourceChatId:number,sourceThreadId:number):Promise<boolean>{
  const topic=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_photo_database_topics WHERE style=?").bind(style).first<{chat_id:string;thread_id:number}>();
  if(!topic||topic.chat_id===String(sourceChatId)&&topic.thread_id===sourceThreadId)return false;
  const photos=await env.DB.prepare("SELECT position,telegram_file_id FROM model_telegram_photo_sets WHERE model_id=? AND style=? ORDER BY position").bind(modelId,style).all<{position:number;telegram_file_id:string}>();
  if((photos.results?.length??0)!==7||photos.results!.some((photo,index)=>photo.position!==index+1))throw new Error("Для публикации в PHOTO DATABASE нужны ровно 7 фотографий.");
  const model=await env.DB.prepare("SELECT first_name,last_name FROM models WHERE id=?").bind(modelId).first<{first_name:string;last_name:string}>();
  const sent=await telegram(env.SECRETARY_BOT_TOKEN,"sendMediaGroup",{chat_id:topic.chat_id,message_thread_id:topic.thread_id,media:photos.results!.map((photo,index)=>({type:"photo",media:photo.telegram_file_id,...(index===0?{caption:(model?.first_name??"")+" "+(model?.last_name??"")+" | "+style.toUpperCase()}: {})}))});
  const ids=(sent.result??[]).map((item:any)=>item.message_id).filter((id:any)=>Number.isSafeInteger(id)&&id>0);
  if(ids.length!==7)throw new Error("Telegram не вернул ID всех 7 опубликованных фотографий.");
  await recordSecretaryPhotoDatabasePublication(env,modelId,style,topic.chat_id,topic.thread_id,ids);
  return true;
}
async function handleSecretaryAlbumMessage(env: Env, message: TelegramMessage, senderId: string): Promise<void> {
  const albumId = message.media_group_id!;
  const threadId = message.message_thread_id;
  if (threadId === undefined) return;
  const databaseTopic = await env.DB.prepare("SELECT style FROM secretary_photo_database_topics WHERE chat_id=? AND thread_id=?").bind(String(message.chat.id),threadId).first<{style:"basic"|"fashion"}>();
  const databaseStyle = databaseTopic?.style ?? null;
  const uploadIntent = databaseStyle ? null : await env.DB.prepare("SELECT model_id,style FROM secretary_photo_upload_intents WHERE chat_id=? AND thread_id=? AND uploader_id=? AND created_at>=datetime('now','-30 minutes')").bind(String(message.chat.id),threadId,senderId).first<{model_id:string;style:"basic"|"fashion"|null}>();
  const media = message.photo?.length ? message.photo[message.photo.length - 1] : message.document;
  if (!media) return;
  if (message.document) {
    const mime = (message.document.mime_type ?? "").toLowerCase();
    const fileName = (message.document.file_name ?? "").toLowerCase();
    const supportedByName = /\.(jpe?g|png|webp)$/.test(fileName);
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime) && !supportedByName) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "Не удалось распознать формат файла. Отправьте 7 изображений JPEG, PNG или WEBP как файлы." });
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
  let captionStyle: "basic"|"fashion"|null = null;
  let modelId: string | null = null;
  if (caption) {
    if (caption.length > 120 || /[\r\n]/.test(caption)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "В подписи укажите имя и фамилию модели, при необходимости добавив BASIC или FASHION." });
      return;
    }
    let modelCaption=caption;
    const stylePrefix=modelCaption.match(/^(basic|fashion)\s+(.+)$/i);
    const styleSuffix=modelCaption.match(/^(.+?)\s+(basic|fashion)$/i);
    if(stylePrefix){captionStyle=stylePrefix[1].toLowerCase() as "basic"|"fashion";modelCaption=stylePrefix[2].trim();}
    else if(styleSuffix){captionStyle=styleSuffix[2].toLowerCase() as "basic"|"fashion";modelCaption=styleSuffix[1].trim();}
    const target = normalizeName(modelCaption);
    const models = await getActiveModels(env);
    const matches = models.filter((m) => normalizeName(m.first_name + " " + m.last_name) === target);
    if (matches.length !== 1) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: matches.length ? "Найдено несколько анкет с таким ФИО. Уточните данные в базе." : "Анкета «" + modelCaption + "» не найдена. Проверьте ФИО." });
      return;
    }
    modelId = matches[0].id;
    if(uploadIntent && uploadIntent.model_id!==modelId){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:threadId,text:"Этот альбом не совпадает с выбранной в MODEL BANK моделью. Начните загрузку заново."});
      return;
    }
    if(uploadIntent?.style && captionStyle && uploadIntent.style!==captionStyle){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:threadId,text:"Стиль в подписи не совпадает с выбранным стилем загрузки."});
      return;
    }
  } else {
    const existing = await env.DB.prepare(
      "SELECT model_id FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? AND model_id IS NOT NULL LIMIT 1",
    ).bind(String(message.chat.id), threadId, senderId, albumId).first<{model_id:string}>();
    modelId = existing?.model_id ?? uploadIntent?.model_id ?? null;
  }
  if(databaseStyle && captionStyle && captionStyle!==databaseStyle){
    await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:threadId,text:"Стиль в подписи не совпадает с темой. В этой теме принимаются только "+(databaseStyle==="basic"?"BASIC":"FASHION")+"-комплекты."});
    return;
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
  if (items.length && !databaseStyle) await trackSecretaryPhotoUploadMessages(env,message.chat.id,threadId,senderId,{photoIds:items.map(item=>item.message_id)});
  if (items.length > 7) {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "В альбоме должно быть ровно 7 фотографий. Отправьте комплект заново." });
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
  if (items.length !== 7) {
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
      const text = `Фото: ${items.length}/7`;
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
          await trackSecretaryPhotoUploadMessages(env,message.chat.id,threadId,senderId,{botIds:[sentMessageId]});
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
  const progressMessageId = progressStatus?.status_message_id ?? null;
  if (items.some((item) => item.model_id !== resolvedModelId)) {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    if (progressMessageId) {
      try { await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: message.chat.id, message_id: progressMessageId }); } catch {}
    }
    await env.DB.prepare("DELETE FROM secretary_photo_album_status WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), threadId, senderId, albumId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: threadId, text: "У фотографий альбома должно быть одно ФИО в подписи первого снимка. Отправьте комплект заново." });
    return;
  }
  if (progressMessageId) {
    try {
      await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id, message_id: progressMessageId,
        text: "Получены все 7 фотографий. Сохраняю комплект…",
        reply_markup: secretaryCancelKeyboard(albumOperation.id),
      });
    } catch (error) {
      console.error("Failed to update photo album progress message", error);
    }
  }
  const newPhotos=items.map(({file_id,file_unique_id})=>({file_id,file_unique_id}));
  const selectedStyle = databaseStyle ?? uploadIntent?.style ?? captionStyle;
  const model=await env.DB.prepare("SELECT first_name,last_name FROM models WHERE id=?").bind(resolvedModelId).first<{first_name:string;last_name:string}>();
  if(selectedStyle){
    await saveSecretaryPhotoSet(env,resolvedModelId,newPhotos,senderId,message.chat.id,threadId,selectedStyle);
    await finishSecretaryOperation(env,albumOperation.id,"completed");
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id=? AND thread_id=? AND uploader_id=? AND media_group_id=?").bind(String(message.chat.id),threadId,senderId,albumId).run();
    await env.DB.prepare("DELETE FROM secretary_photo_album_status WHERE chat_id=? AND thread_id=? AND uploader_id=? AND media_group_id=?").bind(String(message.chat.id),threadId,senderId,albumId).run();
    await env.DB.prepare("DELETE FROM secretary_photo_upload_intents WHERE chat_id=? AND thread_id=? AND uploader_id=?").bind(String(message.chat.id),threadId,senderId).run();
    if(databaseStyle){
      const caption=(model?.first_name??"")+" "+(model?.last_name??"")+" "+selectedStyle.toUpperCase();
      const published=await telegram(env.SECRETARY_BOT_TOKEN,"sendMediaGroup",{chat_id:message.chat.id,message_thread_id:threadId,media:items.map((item,index)=>({type:"photo",media:item.file_id,...(index===0?{caption}: {})}))});
      const publishedIds=(published.result??[]).map((item:any)=>item.message_id).filter((id:any)=>Number.isSafeInteger(id)&&id>0);
      if(publishedIds.length!==7)throw new Error("Не удалось опубликовать все 7 фотографий от имени бота; исходный альбом оставлен.");
      await recordSecretaryPhotoDatabasePublication(env,resolvedModelId,selectedStyle,message.chat.id,threadId,publishedIds);
      for(const item of items)await deleteTelegramMessage(env,message.chat.id,item.message_id,"replace source album with bot publication");
      if(progressMessageId) await deleteTelegramMessage(env,message.chat.id,progressMessageId,"external photo database album complete");
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:threadId,text:"Готово: "+caption+". Альбом опубликован от имени бота."});
    }else{
      try{await publishSecretaryPhotoSetToDatabase(env,resolvedModelId,selectedStyle,message.chat.id,threadId);}
      catch(error){console.error("Photo database mirror failed",{modelId:resolvedModelId,style:selectedStyle,error:compositeErrorText(error)});await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:threadId,text:"Фотографии сохранены в MODEL BANK, но не удалось обновить внешний PHOTO DATABASE. Проверьте права бота в целевой теме."});}
      await cleanupSecretaryPhotoUploadMessages(env,message.chat.id,threadId,senderId,progressMessageId?[progressMessageId]:[]);
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:threadId,text:"Анкета "+(model?.first_name??"")+" "+(model?.last_name??"")+" · "+(selectedStyle==="basic"?"BASIC":"FASHION")+" обновлена. Новый комплект из 7 фотографий сохранён.",reply_markup:{inline_keyboard:[]}});
    }
    return;
  }
  await finishSecretaryOperation(env,albumOperation.id,"completed");
  await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id=? AND thread_id=? AND uploader_id=? AND media_group_id=?").bind(String(message.chat.id),threadId,senderId,albumId).run();
  await env.DB.prepare("DELETE FROM secretary_photo_album_status WHERE chat_id=? AND thread_id=? AND uploader_id=? AND media_group_id=?").bind(String(message.chat.id),threadId,senderId,albumId).run();
  await env.DB.prepare("DELETE FROM secretary_photo_upload_intents WHERE chat_id=? AND thread_id=? AND uploader_id=?").bind(String(message.chat.id),threadId,senderId).run();
  await env.DB.prepare("INSERT INTO secretary_photo_replacement_pending(chat_id,thread_id,user_id,model_id,photos_json,style) VALUES(?,?,?,?,?,'basic') ON CONFLICT(chat_id,thread_id,user_id) DO UPDATE SET model_id=excluded.model_id,photos_json=excluded.photos_json,style='basic',created_at=CURRENT_TIMESTAMP").bind(String(message.chat.id),threadId,senderId,resolvedModelId,JSON.stringify(newPhotos)).run();
  await cleanupSecretaryPhotoUploadMessages(env,message.chat.id,threadId,senderId,progressMessageId?[progressMessageId]:[]);
  await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:threadId,text:"Анкета "+(model?.first_name??"")+" "+(model?.last_name??"")+". Выберите набор фотографий:",
    reply_markup:{inline_keyboard:[[{text:"Basic",callback_data:"photo_style:basic"},{text:"Fashion",callback_data:"photo_style:fashion"}]]}});
}
async function sendCompositePng(env: Env, chatId: number, threadId: number, png: Uint8Array, caption: string, modelId: string): Promise<number> {
  const endpoint = `https://api.telegram.org/bot${env.SECRETARY_BOT_TOKEN}/sendPhoto`;
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("message_thread_id", String(threadId));
  form.set("caption", caption);
  form.set("reply_markup", JSON.stringify({ inline_keyboard: [[{ text: "📎 Файл", callback_data: "compfile:" + modelId }]] }));
  form.set("photo", new Blob([png], { type: "image/png" }), "intermodels-composite.png");
  const response = await fetch(endpoint, { method: "POST", body: form });
  const result: any = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(`Telegram sendPhoto failed: ${result?.description ?? response.status}`);
  return Number(result.result?.message_id);
}
async function generateCompositeInTopic(env: Env, message: TelegramMessage, rawName: string, style: "basic" | "fashion" = "basic", language: "ru" | "en" = "ru"): Promise<void> {
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
    .bind(String(message.chat.id), message.message_thread_id!, String(message.from!.id)).run();  const model = matches[0];
  const photoResult = await env.DB.prepare("SELECT position, telegram_file_id FROM model_telegram_photo_sets WHERE model_id = ? AND style = ? ORDER BY position").bind(model.id,style).all<{position:number;telegram_file_id:string}>();
  const photos = photoResult.results ?? [];
  if (photos.length !== 7 || photos.some((photo, i) => photo.position !== i + 1)) {
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "У модели отсутствует набор "+(style==="basic"?"Basic":"Fashion")+". Загрузите его в MODEL BANK." }); return;
  }
  const operationId = await startSecretaryOperation(env, "composite", String(message.from!.id), message.chat.id, message.message_thread_id!);
  const status = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id, message_thread_id: message.message_thread_id,
    text: "Готовлю композитку для " + model.first_name + " " + model.last_name + "…",
    reply_markup: secretaryCancelKeyboard(operationId),
  });
  const statusMessageId = status.result?.message_id;
  await setSecretaryOperationStatusMessage(env, operationId, statusMessageId);
  const startedAt = Date.now();
  let compositeStage = "render_png";
  let newMessageId: number | undefined;
  let publicationCommitted = false;
  const updateStage = async (stage: string) => {
    await assertSecretaryOperationActive(env, operationId);
    if (!statusMessageId) return;
    await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
      chat_id: message.chat.id, message_id: statusMessageId,
      text: `Создаю композитку для ${model.first_name} ${model.last_name}…\n${stage}`,
      reply_markup: secretaryCancelKeyboard(operationId),
    });
  };
  try {
    await assertSecretaryOperationActive(env, operationId);
    const png = await renderCompositePng(env, model, photos.map((p) => p.telegram_file_id), updateStage, language);
    await assertSecretaryOperationActive(env, operationId);
    compositeStage = "deliver_png";
    await updateStage("Публикация готового PNG");
    await assertSecretaryOperationActive(env, operationId);
    newMessageId = await sendCompositePng(env, message.chat.id, message.message_thread_id!, png, model.first_name + " " + model.last_name + " · InterModels", model.id);
    if (!Number.isSafeInteger(newMessageId) || newMessageId <= 0) throw new Error("Telegram не вернул ID композитки.");
    const recorded = await recordSecretaryOperationResult(env, operationId, message.chat.id, newMessageId);
    if (!recorded || !(await claimSecretaryOperationPublication(env, operationId))) {
      await deleteTelegramMessage(env, message.chat.id, newMessageId, "cancelled composite before publication");
      newMessageId = undefined;
      throw new Error("SECRETARY_OPERATION_CANCELLED");
    }
    const oldPublication = await env.DB.prepare("SELECT chat_id,message_id FROM composite_topic_publications WHERE model_id=?")
      .bind(model.id).first<{ chat_id: string; message_id: number }>();
    await env.DB.prepare(
      `INSERT INTO composite_topic_publications(model_id,chat_id,thread_id,message_id,campaign_id,published_at,photo_file_ids_json,model_snapshot_json,style,language)
       VALUES(?,?,?,?,NULL,CURRENT_TIMESTAMP,?,?,?,?)
       ON CONFLICT(model_id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,
         message_id=excluded.message_id,campaign_id=NULL,published_at=CURRENT_TIMESTAMP,
         photo_file_ids_json=excluded.photo_file_ids_json,model_snapshot_json=excluded.model_snapshot_json,
         style=excluded.style,language=excluded.language`,
    ).bind(model.id, String(message.chat.id), message.message_thread_id!, newMessageId,
      JSON.stringify(photos.map((photo) => photo.telegram_file_id)), JSON.stringify(model),style,language).run();
    publicationCommitted = true;
    if (oldPublication) {
      try { await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: oldPublication.chat_id, message_id: oldPublication.message_id }); }
      catch (deleteError) { console.error("Previous composite could not be deleted", { modelId: model.id, error: compositeErrorText(deleteError) }); }
    }
    await env.DB.prepare("UPDATE secretary_operations SET result_chat_id=NULL,result_message_id=NULL WHERE id=?")
      .bind(operationId).run();
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
    if (newMessageId && !publicationCommitted) await deleteTelegramMessage(env, message.chat.id, newMessageId, "failed/cancelled composite");
    await finishSecretaryOperation(env, operationId, cancelled ? "cancelled" : "failed");
    const details = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
    console.error("Composite generation failed", { modelId: model.id, stage: compositeStage, ...details });
    if (statusMessageId) {
      if (cancelled) {
        await deleteTelegramMessage(env, message.chat.id, statusMessageId, "cancelled composite status");
      } else {
        try {
          await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
            chat_id: message.chat.id, message_id: statusMessageId,
            text: "Не удалось создать композитку. Ошибка записана, можно попробовать ещё раз позже.",
            reply_markup: { inline_keyboard: [] },
          });
        } catch (notifyError) {
          console.error("Unable to report composite generation failure", notifyError);
        }
      }
    }
  }
}
async function generateCompositeBatchInTopic(env: Env, message: TelegramMessage, names: string[], inputMessageIds: number[] = [], style: "basic" | "fashion" = "basic", language: "ru" | "en" = "ru"): Promise<void> {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id!;
  // Remove the submitted surname message(s) immediately; each name gets its own progress message below.
  for (const messageId of inputMessageIds) {
    await deleteTelegramMessage(env, chatId, messageId, "composite batch source input");
  }
  const operationId = await startSecretaryOperation(env, "composite_batch", String(message.from!.id), chatId, threadId);
  const intro = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: chatId, message_thread_id: threadId, text: "Готовлю поток композиток…",
  });
  await env.DB.prepare("UPDATE secretary_operations SET intro_message_id=? WHERE id=?")
    .bind(intro.result?.message_id ?? null, operationId).run();
  let queued = 0;
  for (let index = 0; index < names.length; index++) {
    const requestedName = names[index].trim();
    let modelId: string | null = null;
    let itemStyle: "basic" | "fashion" = style;
    let failure: string | null = null;
    try {
      const normalized = normalizeName(requestedName);
      const parts = normalized.split(" ");
      const surname = parts[parts.length - 1] ?? normalized;
      const candidates = await findSecretaryModels(env, surname);
      const exact = candidates.filter((m) => normalizeName(m.first_name + " " + m.last_name) === normalized);
      const matches = exact.length ? exact : candidates;
      if (!matches.length) throw new Error("Модель не найдена.");
      if (matches.length > 1) throw new Error("Найдено несколько моделей. Укажите имя и фамилию полностью.");
      modelId = matches[0].id;
      const available = await env.DB.prepare("SELECT style,COUNT(*) AS count,MIN(position) AS min_position,MAX(position) AS max_position FROM model_telegram_photo_sets WHERE model_id=? GROUP BY style")
        .bind(modelId).all<{style:"basic"|"fashion";count:number;min_position:number;max_position:number}>();
      const validStyles = (available.results ?? []).filter(row => row.count === 7 && row.min_position === 1 && row.max_position === 7).map(row => row.style);
      const effectiveStyle = validStyles.includes(itemStyle) ? itemStyle : validStyles.length === 1 ? validStyles[0] : null;
      if (!effectiveStyle) throw new Error("У модели нет полного набора фотографий выбранного стиля. Проверьте MODEL BANK.");
      const photoResult = await env.DB.prepare("SELECT position FROM model_telegram_photo_sets WHERE model_id=? AND style=? ORDER BY position")
        .bind(modelId, effectiveStyle).all<{position:number}>();
      const photos = photoResult.results ?? [];
      if (photos.length !== 7 || photos.some((photo, i) => photo.position !== i + 1)) {
        throw new Error("У модели отсутствует полный комплект фотографий. Загрузите его в MODEL BANK.");
      }
      itemStyle = effectiveStyle;
      queued++;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const itemId = randomId();
    await env.DB.prepare(
      "INSERT INTO secretary_composite_batch_items(id,operation_id,position,requested_name,model_id,status,last_error,style,language) VALUES(?,?,?,?,?,?,?,?,?)",
    ).bind(itemId, operationId, index + 1, requestedName, modelId, failure ? "failed" : "pending", failure, itemStyle, language).run();
    const itemMessage = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: chatId, message_thread_id: threadId,
      text: failure ? "❌ " + requestedName + " — " + failure : "⏳ " + requestedName + " — В очереди",
    });
    if (itemMessage.result?.message_id) {
      await env.DB.prepare("UPDATE secretary_composite_batch_items SET status_message_id=? WHERE id=?")
        .bind(itemMessage.result.message_id, itemId).run();
    }
  }

  const stats = await env.DB.prepare(
    "SELECT COUNT(*) AS total,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS queued,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM secretary_composite_batch_items WHERE operation_id=?",
  ).bind(operationId).first<{total:number;queued:number|null;failed:number|null}>();
  const status = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: chatId, message_thread_id: threadId,
    text: "Поток принят. В очереди: " + (stats?.queued ?? 0) + " · ошибок: " + (stats?.failed ?? 0),
    ...(stats?.queued ? { reply_markup: secretaryCancelKeyboard(operationId) } : {}),
  });
  const queue = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
    chat_id: chatId, message_thread_id: threadId,
    text: stats?.queued ? "Очередь: " + stats.queued + " моделей." : "Очередь пуста.",
  });
  await setSecretaryOperationStatusMessage(env, operationId, status.result?.message_id);
  await env.DB.prepare("UPDATE secretary_operations SET queue_message_id=? WHERE id=?")
    .bind(queue.result?.message_id ?? null, operationId).run();
  if (!(stats?.queued ?? 0)) {
    await finishSecretaryOperation(env, operationId, "completed");
    await env.DB.prepare("UPDATE secretary_operations SET cleanup_at=datetime('now','+2 minutes') WHERE id=?").bind(operationId).run();
    return;
  }
  await updateSecretaryCompositeBatchStatus(env, operationId, "Очередь подготовлена");
}

async function updateSecretaryCompositeBatchStatus(env: Env, operationId: string, stage?: string): Promise<void> {
  const operation = await env.DB.prepare(
    "SELECT chat_id,status_message_id,queue_message_id,status FROM secretary_operations WHERE id=? AND kind='composite_batch'",
  ).bind(operationId).first<{chat_id:string;status_message_id:number|null;queue_message_id:number|null;status:string}>();
  if (!operation || !operation.status_message_id || operation.status !== "running") return;
  const stats = await env.DB.prepare(
    "SELECT COUNT(*) AS total,SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM secretary_composite_batch_items WHERE operation_id=?",
  ).bind(operationId).first<{total:number;published:number|null;failed:number|null}>();
  const total = stats?.total ?? 0;
  const published = stats?.published ?? 0;
  const failed = stats?.failed ?? 0;
  const text = `Сейчас: ${stage ?? "обработка очереди"}\nГотово: ${published}/${total} · ошибок: ${failed}`;
  try {
    await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
      chat_id: operation.chat_id, message_id: operation.status_message_id,
      text, reply_markup: secretaryCancelKeyboard(operationId),
    });
  } catch (error) {
    console.warn("Unable to update composite batch status", {operationId,error:compositeErrorText(error)});
  }
  if (operation.queue_message_id) {
    const queuedRows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM secretary_composite_batch_items WHERE operation_id=? AND status='pending'",
    ).bind(operationId).first<{count:number}>();
    const count = queuedRows?.count ?? 0;
    const queueText = count ? `В очереди: ${count} ${count === 1 ? "модель" : count < 5 ? "модели" : "моделей"}.` : "Очередь пуста.";
    try {
      await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
        chat_id: operation.chat_id, message_id: operation.queue_message_id, text: queueText,
      });
    } catch (error) { console.warn("Unable to update composite queue message", {operationId,error:compositeErrorText(error)}); }
  }
}

async function finalizeSecretaryCompositeBatchOperation(env: Env, operationId: string): Promise<void> {
  const operation = await env.DB.prepare("SELECT status,chat_id,status_message_id,queue_message_id FROM secretary_operations WHERE id=? AND kind='composite_batch'")
    .bind(operationId).first<{status:string;chat_id:string;status_message_id:number|null;queue_message_id:number|null}>();
  if (operation?.status !== "running") return;
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM secretary_composite_batch_items WHERE operation_id=? AND status IN ('pending','processing')",
  ).bind(operationId).first<{count:number}>();
  if ((remaining?.count ?? 0) > 0) return;
  const stats = await env.DB.prepare(
    "SELECT COUNT(*) AS total,SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM secretary_composite_batch_items WHERE operation_id=?",
  ).bind(operationId).first<{total:number;published:number|null;failed:number|null}>();
  const failedRows = await env.DB.prepare(
    "SELECT requested_name,last_error FROM secretary_composite_batch_items WHERE operation_id=? AND status='failed' ORDER BY position",
  ).bind(operationId).all<{requested_name:string;last_error:string|null}>();
  const failureDetails = (failedRows.results ?? []).map((row) => "• " + row.requested_name + " — " + (row.last_error ?? "ошибка рендеринга")).join("\n").slice(0, 2800);
  await finishSecretaryOperation(env,operationId,"completed");
  if (operation.status_message_id) {
    try {
      await telegram(env.SECRETARY_BOT_TOKEN,"editMessageText",{
        chat_id:operation.chat_id,message_id:operation.status_message_id,
        text:`Поток завершён. Создано: ${stats?.published??0} из ${stats?.total??0}. Ошибок: ${stats?.failed??0}.` + (failureDetails ? "\n\nОшибки записаны в журнал:\n" + failureDetails : ""),
        reply_markup:{inline_keyboard:[]},
      });
    } catch(error) { console.warn("Unable to finalize composite batch status",compositeErrorText(error)); }
  }
  if (operation.queue_message_id) {
    try { await telegram(env.SECRETARY_BOT_TOKEN,"editMessageText",{chat_id:operation.chat_id,message_id:operation.queue_message_id,text:"Очередь завершена."}); }
    catch(error) { console.warn("Unable to finalize composite queue message",compositeErrorText(error)); }
  }
  await env.DB.prepare("UPDATE secretary_operations SET cleanup_at=datetime('now','+2 minutes') WHERE id=?").bind(operationId).run();
}

async function cleanupSecretaryCompositeBatchMessages(env: Env): Promise<void> {
  const expired = await env.DB.prepare(
    "SELECT id,chat_id,status_message_id,intro_message_id,queue_message_id,input_message_id FROM secretary_operations WHERE kind='composite_batch' AND cleanup_at IS NOT NULL AND cleanup_at<=datetime('now')",
  ).all<{id:string;chat_id:string;status_message_id:number|null;intro_message_id:number|null;queue_message_id:number|null;input_message_id:string|null}>();
  for (const operation of expired.results ?? []) {
    const ids = new Set<number>();
    for (const id of [operation.status_message_id,operation.intro_message_id,operation.queue_message_id]) if (id) ids.add(id);
    if (operation.input_message_id) {
      try { for (const id of JSON.parse(operation.input_message_id) as number[]) if (Number.isSafeInteger(id) && id>0) ids.add(id); } catch {}
    }
    for (const messageId of ids) await deleteTelegramMessage(env,operation.chat_id,messageId,"composite batch temporary UI cleanup");
    await env.DB.prepare("UPDATE secretary_operations SET status_message_id=NULL,intro_message_id=NULL,queue_message_id=NULL,input_message_id=NULL,cleanup_at=NULL WHERE id=?")
      .bind(operation.id).run();
  }
}

async function processSecretaryCompositeBatchJobs(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE secretary_composite_batch_items SET status='failed',last_error='Задание зависло при обработке более 10 минут.',updated_at=CURRENT_TIMESTAMP WHERE status='processing' AND updated_at < datetime('now','-10 minutes')",
  ).run();
  const running = await env.DB.prepare(
    "SELECT id FROM secretary_operations WHERE kind='composite_batch' AND status='running'",
  ).all<{id:string}>();
  for (const operation of running.results ?? []) await finalizeSecretaryCompositeBatchOperation(env, operation.id);

  // A single global in-flight guard prevents overlapping Cron invocations from
  // starting another render while the previous one is still running.
  const job = await env.DB.prepare(
    `SELECT j.id,j.operation_id,j.model_id,j.requested_name,j.style,j.language,j.status_message_id,o.chat_id
     FROM secretary_composite_batch_items j
     JOIN secretary_operations o ON o.id=j.operation_id
     WHERE j.status='pending' AND o.status='running'
       AND NOT EXISTS (SELECT 1 FROM secretary_composite_batch_items active WHERE active.status='processing')
     ORDER BY j.created_at,j.position LIMIT 1`,
  ).first<{id:string;operation_id:string;model_id:string;requested_name:string;style:"basic"|"fashion";language:"ru"|"en";status_message_id:number|null;chat_id:string}>();
  if (!job) return;
  const claim = await env.DB.prepare(
    "UPDATE secretary_composite_batch_items SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM secretary_composite_batch_items WHERE status='processing') AND EXISTS (SELECT 1 FROM secretary_operations WHERE id=? AND status='running')",
  ).bind(job.id, job.operation_id).run();
  if (!(claim.meta?.changes ?? 0)) return;

  const editItem = async (text: string) => {
    if (!job.status_message_id) return;
    try {
      await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
        chat_id: job.chat_id, message_id: job.status_message_id, text,
      });
    } catch (error) {
      console.warn("Unable to update composite batch item message", {jobId:job.id,error:compositeErrorText(error)});
    }
  };
  try {
    await editItem("⚙️ " + job.requested_name + " — В работе");
    await updateSecretaryCompositeBatchStatus(env, job.operation_id, "Сейчас: " + job.requested_name);
    await publishCompositeModel(env, null, job.model_id, async (stage) => {
      await assertSecretaryOperationActive(env, job.operation_id);
      await editItem("⚙️ " + job.requested_name + " — " + stage);
      await updateSecretaryCompositeBatchStatus(env, job.operation_id, job.requested_name + " · " + stage);
    }, job.operation_id, job.style, job.language);
    await env.DB.prepare("UPDATE secretary_composite_batch_items SET status='published',last_error=NULL,status_message_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='processing'")
      .bind(job.id).run();
    if (job.status_message_id) {
      await deleteTelegramMessage(env, job.chat_id, job.status_message_id, "completed composite batch item status");
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const cancelled = details === "SECRETARY_OPERATION_CANCELLED";
    await env.DB.prepare("UPDATE secretary_composite_batch_items SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='processing'")
      .bind(cancelled ? "cancelled" : "failed", cancelled ? null : details.slice(0, 1500), job.id).run();
    if (cancelled) {
      await deleteTelegramMessage(env, job.chat_id, job.status_message_id ?? undefined, "cancelled composite batch item status");
    } else {
      await editItem("❌ " + job.requested_name + " — Не удалось создать композитку");
    }
    if (!cancelled) console.error("Secretary composite batch item failed", {operationId:job.operation_id,jobId:job.id,modelId:job.model_id,error:details});
  }
  await finalizeSecretaryCompositeBatchOperation(env, job.operation_id);
  await updateSecretaryCompositeBatchStatus(env, job.operation_id);
}

async function secretaryTopicDiagnostics(env:Env,_chatId:number):Promise<string>{
  const photo=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_photo_topics WHERE id=1").first<{chat_id:string;thread_id:number}>();
  const basic=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_photo_database_topics WHERE style='basic'").first<{chat_id:string;thread_id:number}>();
  const fashion=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_photo_database_topics WHERE style='fashion'").first<{chat_id:string;thread_id:number}>();
  const comp=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id=1").first<{chat_id:string;thread_id:number}>();
  const sameGroup=Boolean(photo&&comp&&photo.chat_id===comp.chat_id);
  const me=await telegram(env.SECRETARY_BOT_TOKEN,"getMe",{}).catch(()=>null);
  const botId=me?.result?.id;
  const inspectGroup=async(id:string|null|undefined)=>{
    if(!id||!botId)return {chat:null,member:null};
    const [chat,member]=await Promise.all([
      telegram(env.SECRETARY_BOT_TOKEN,"getChat",{chat_id:Number(id)}).catch(()=>null),
      telegram(env.SECRETARY_BOT_TOKEN,"getChatMember",{chat_id:Number(id),user_id:botId}).catch(()=>null)
    ]);
    return {chat:chat?.result??null,member:member?.result??null};
  };
  const photoGroup=await inspectGroup(photo?.chat_id);
  const compGroup=sameGroup?photoGroup:await inspectGroup(comp?.chat_id);
  const canDelete=(member:any)=>member?.status==="creator"||(member?.status==="administrator"&&member?.can_delete_messages===true);
  const groupStatus=(data:{chat:any;member:any})=>{
    if(!data.chat)return "нет доступа к группе";
    const forum=data.chat.is_forum===true?"форум":"не форум";
    const member=data.member?.status??"статус бота неизвестен";
    return forum+" · бот: "+member;
  };
  const permissionStatus=(data:{chat:any;member:any})=>data.member?(canDelete(data.member)?"может удалять сообщения":"нет права can_delete_messages"):"не удалось проверить";
  return [
    "🔎 Проверка тем InterModels",
    "MODEL BANK: "+(photo?(photo.chat_id+" · topic ID "+photo.thread_id):"не подключена"),
    "PHOTO DATABASE BASIC: "+(basic?(basic.chat_id+" · topic ID "+basic.thread_id):"не подключена"),
    "PHOTO DATABASE FASHION: "+(fashion?(fashion.chat_id+" · topic ID "+fashion.thread_id):"не подключена"),
    "КОМПОЗИТКИ: "+(comp?(comp.chat_id+" · topic ID "+comp.thread_id):"не подключена"),
    "Группа MODEL BANK: "+(photo?groupStatus(photoGroup):"не настроена"),
    "Группа КОМПОЗИТКИ: "+(comp?groupStatus(compGroup):"не настроена"),
    "Обе темы в одной группе: "+(sameGroup?"да":"нет"),
    "ID тем различаются: "+(photo&&comp&&photo.thread_id!==comp.thread_id?"да":"нет"),
    "Удаление в MODEL BANK: "+(photo?permissionStatus(photoGroup):"не проверяется"),
    "Удаление в КОМПОЗИТКАХ: "+(comp?permissionStatus(compGroup):"не проверяется"),
    "Название и существование конкретных тем: не проверяются — Telegram Bot API не предоставляет чтение списка тем или их названий."
  ].join("\n");
}
async function handleSecretaryGroupMessage(env: Env, message: TelegramMessage): Promise<void> {
  if (!message.from || (message.chat.type !== "group" && message.chat.type !== "supergroup")) return;
  const senderId = String(message.from.id);
  const command = (message.text ?? "").trim();
  const setupText = command.match(/^подключить\s+(basic|fashion|model\s*bank|композитки)$/i);
  if(setupText){
    if(!message.message_thread_id){await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,text:"Отправьте фразу подключения внутри нужной темы Telegram."});return;}
    if(!hasDirectorAccess(env,senderId)){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Подключать темы может только владелец или директор."});return;
    }
    const target=setupText[1].toLowerCase().replace(/\s+/g," ");
    if(target==="basic"||target==="fashion"){
      const style=target as "basic"|"fashion";
      await env.DB.prepare("INSERT INTO secretary_photo_database_topics(style,chat_id,thread_id,configured_by) VALUES(?,?,?,?) ON CONFLICT(style) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,configured_by=excluded.configured_by,created_at=CURRENT_TIMESTAMP")
        .bind(style,String(message.chat.id),message.message_thread_id,senderId).run();
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Тема PHOTO DATABASE "+style.toUpperCase()+" подключена. Публикуйте альбомы ровно из 7 фотографий с подписью «Имя Фамилия». Новый комплект автоматически заменит предыдущий для этого стиля."});return;
    }
    if(target==="model bank"){
      await env.DB.prepare("INSERT INTO secretary_photo_topics(id,chat_id,thread_id,configured_by) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,configured_by=excluded.configured_by")
        .bind(String(message.chat.id),message.message_thread_id,senderId).run();
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Тема MODEL BANK подключена. Напишите имя и фамилию модели, при желании добавив BASIC или FASHION, затем отправьте альбом из 7 фотографий."});return;
    }
    await env.DB.prepare("INSERT INTO secretary_composite_topics(id,chat_id,thread_id,configured_by) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,configured_by=excluded.configured_by")
      .bind(String(message.chat.id),message.message_thread_id,senderId).run();
    await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Тема КОМПОЗИТКИ подключена. Напишите имя или фамилию модели — одна строка для одиночной композитки, несколько строк для массовой. Стиль определяется по доступным фотокомплектам: если их несколько, бот предложит выбор. Язык бот спрашивает всегда."});return;
  }
  console.info("Secretary group update", {
    chatId: message.chat.id,
    threadId: message.message_thread_id ?? null,
    senderId,
    command: command.slice(0, 120),
  });
  if (!message.message_thread_id) {
    if(/^\/topics_check(?:@\w+)?$/i.test(command)){
      if(!hasDirectorAccess(env,senderId)){await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,text:"Проверка тем доступна только владельцу или директору."});return;}
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,text:await secretaryTopicDiagnostics(env,message.chat.id)});return;
    }
    if (/^\/(?:comp|comps)(?:@\w+)?(?:\s|$)/i.test(command) || /^\/comp_help(?:@\w+)?$/i.test(command)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "Композитки можно создавать только внутри темы «КОМПОЗИТКИ» командами /comp или /comps.",
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
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Тема «КОМПОЗИТКИ» подключена. Просто отправьте имя или фамилию модели. Одна строка — одна композитка, несколько строк — массовая генерация. Стиль определяется по доступным фотокомплектам: если их несколько, бот предложит выбор. Язык бот спрашивает всегда." }); return;
  }
  if(/^\/topics_check(?:@\w+)?$/i.test(command)){
    if(!hasDirectorAccess(env,senderId)){await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Проверка тем доступна только владельцу или директору."});return;}
    await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:await secretaryTopicDiagnostics(env,message.chat.id)});return;
  }
  const compositeTopic = await env.DB.prepare("SELECT chat_id, thread_id FROM secretary_composite_topics WHERE id = 1").first<{chat_id:string;thread_id:number}>();
  const isCompositeTopic = Boolean(compositeTopic && compositeTopic.chat_id === String(message.chat.id) && compositeTopic.thread_id === message.message_thread_id);
  const isCompCommand = /^\/(?:comp|comps)(?:@\w+)?(?:\s|$)/i.test(command) || /^\/comp_help(?:@\w+)?$/i.test(command);
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
    const republishCommand=command.match(/^\/photo_republish(?:@\w+)?\s+(.+?)\s+(basic|fashion)$/i);
  if(republishCommand){
    if(!hasDirectorAccess(env,senderId)){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Повторная публикация доступна только владельцу или директору."});
      return;
    }
    const requestedName=republishCommand[1].trim();
    const style=republishCommand[2].toLowerCase() as "basic"|"fashion";
    const models=await getActiveModels(env);
    const matches=models.filter(model=>normalizeName(model.first_name+" "+model.last_name)===normalizeName(requestedName));
    if(matches.length!==1){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:matches.length?"Найдено несколько анкет. Укажите полное имя и фамилию.":"Анкета «"+requestedName+"» не найдена."});
      return;
    }
    const model=matches[0];
    try{
      const published=await publishSecretaryPhotoSetToDatabase(env,model.id,style,message.chat.id,message.message_thread_id);
      if(!published)throw new Error("Тема "+style.toUpperCase()+" не настроена или совпадает с MODEL BANK.");
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Готово: "+model.first_name+" "+model.last_name+" · "+style.toUpperCase()+". В PHOTO DATABASE опубликованы все 7 фотографий из сохранённого комплекта."});
    }catch(error){
      console.error("Manual photo database republish failed",{modelId:model.id,style,error:compositeErrorText(error)});
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Не удалось опубликовать "+style.toUpperCase()+" для "+model.first_name+" "+model.last_name+": "+compositeErrorText(error).slice(0,350)+". Сохранённый комплект в MODEL BANK не изменён."});
    }
    return;
  }
  if (!(await secretaryAllowed(env, senderId))) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id,
        text: "У вас нет права создавать композитки. Попросите директора выдать доступ.",
      });
      return;
    }
    const optionPending=await env.DB.prepare("SELECT stage,mode,style,language,names_text,command_message_id,prompt_message_id FROM secretary_composite_request_pending WHERE chat_id=? AND thread_id=? AND user_id=? AND created_at>=datetime('now','-30 minutes')").bind(String(message.chat.id),message.message_thread_id,senderId).first<{stage:string;mode:"single"|"batch";style:"basic"|"fashion"|null;language:"ru"|"en"|null;names_text:string|null;command_message_id:number|null;prompt_message_id:number|null}>();
    if(optionPending?.stage==="names"&&command&&!command.startsWith("/")){
      const names=command.split(/\r?\n/).map(name=>name.trim()).filter(Boolean);
      const validCount=optionPending.mode==="single"?names.length===1:names.length>=1&&names.length<=20;
      if(!validCount||names.some(name=>name.length>100)){await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:optionPending.mode==="single"?"Отправьте ФИО только одной модели. Для списка используйте /comps.":"Отправьте от 1 до 20 фамилий или ФИО — по одной модели на строку."});return;}
      await env.DB.prepare("DELETE FROM secretary_composite_request_pending WHERE chat_id=? AND thread_id=? AND user_id=?").bind(String(message.chat.id),message.message_thread_id,senderId).run();
      const ids=[optionPending.command_message_id,optionPending.prompt_message_id,message.message_id].filter((id):id is number=>typeof id==="number");
      if(optionPending.mode==="single") await generateCompositeInTopic(env,message,names[0],optionPending.style??"basic",optionPending.language??"ru");
      else await generateCompositeBatchInTopic(env,message,names,ids,optionPending.style??"basic",optionPending.language??"ru");
      return;
    }
    const generationCommand=command.match(/^\/(comp|comps)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
    if(generationCommand){
      const mode=generationCommand[1].toLowerCase()==="comp"?"single":"batch";
      const rawNames=(generationCommand[2]??"").trim();
      const names=rawNames?rawNames.split(/\r?\n/).map(name=>name.trim()).filter(Boolean):[];
      const validCount=mode==="single"?names.length<=1:names.length<=20;
      if(!validCount||names.some(name=>name.length>100)){
        await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:mode==="single"?"Команда /comp принимает только одну модель. Для списка используйте /comps.":"Для /comps отправьте не более 20 моделей — по одной на строку."});return;
      }
      if(rawNames){
        await handleSecretaryGroupMessage(env,{...message,text:rawNames});
        return;
      }
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:mode==="single"?"Отправьте ФИО одной модели.":"Отправьте от 1 до 20 моделей — по одной на строку."});return;
    }
    if(/^\/comp_help(?:@\w+)?$/i.test(command)){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Просто отправьте имя или фамилию. Одна строка — одна композитка; несколько строк — пакет. Стиль определяется по доступным фотокомплектам: если их несколько, бот предложит выбор. Язык бот спрашивает всегда."});return;
    }
    if(command && !command.startsWith("/")){
      const lines=command.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      const names=lines.map(line=>line.replace(/^(basic|fashion)\s+/i,"").replace(/\s+(basic|fashion)$/i,"").trim());
      if(!names.length||names.length>20||names.some(name=>!name||name.length>100)){
        await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Отправьте от 1 до 20 моделей — по одной на строку."});return;
      }
      const modelStyles:Array<"basic"|"fashion">=[];
      let hasStyleChoice=false;
      for(const name of names){
        const normalized=normalizeName(name),parts=normalized.split(" "),surname=parts[parts.length-1]??normalized;
        const candidates=await findSecretaryModels(env,surname);
        const exact=candidates.filter(m=>normalizeName(m.first_name+" "+m.last_name)===normalized);
        const matches=exact.length?exact:candidates;
        if(matches.length!==1){
          await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:matches.length?"Уточните ФИО полностью — по одной модели на строку.":"Модель «"+name+"» не найдена."});return;
        }
        const sets=await env.DB.prepare("SELECT style,COUNT(*) AS count,MIN(position) AS min_position,MAX(position) AS max_position FROM model_telegram_photo_sets WHERE model_id=? GROUP BY style")
          .bind(matches[0].id).all<{style:"basic"|"fashion";count:number;min_position:number;max_position:number}>();
        const valid=(sets.results??[]).filter(row=>row.count===7&&row.min_position===1&&row.max_position===7).map(row=>row.style);
        if(!valid.length){await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"У модели «"+name+"» нет полного комплекта из 7 фотографий в MODEL BANK."});return;}
        if(valid.length>1)hasStyleChoice=true;
        modelStyles.push(valid[0]);
      }
      const initialStyle=modelStyles[0]??"basic";
      const initialStage=hasStyleChoice?"style":"language";
      await env.DB.prepare("INSERT INTO secretary_composite_request_pending(chat_id,thread_id,user_id,stage,mode,style,language,names_text,command_message_id,prompt_message_id) VALUES(?,?,?, ?,?,?,NULL,?,?,NULL) ON CONFLICT(chat_id,thread_id,user_id) DO UPDATE SET stage=excluded.stage,mode=excluded.mode,style=excluded.style,language=NULL,names_text=excluded.names_text,command_message_id=excluded.command_message_id,prompt_message_id=NULL,created_at=CURRENT_TIMESTAMP")
        .bind(String(message.chat.id),message.message_thread_id,senderId,initialStage,names.length===1?"single":"batch",initialStyle,names.join("\n"),message.message_id).run();
      const promptText=hasStyleChoice?"Выберите стиль композитки:":"Выберите язык композитки:";
      const keyboard=hasStyleChoice?[[{text:"Basic",callback_data:"comp_style:basic"},{text:"Fashion",callback_data:"comp_style:fashion"}]]:[[{text:"Русский",callback_data:"comp_lang:ru"},{text:"English",callback_data:"comp_lang:en"}]];
      const optionPrompt=await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:promptText,reply_markup:{inline_keyboard:keyboard}});
      await env.DB.prepare("UPDATE secretary_composite_request_pending SET prompt_message_id=? WHERE chat_id=? AND thread_id=? AND user_id=?")
        .bind(optionPrompt.result?.message_id??null,String(message.chat.id),message.message_thread_id,senderId).run();
      return;
    }
    if (command.startsWith("/")) {
      await env.DB.prepare("DELETE FROM secretary_composite_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ?")
        .bind(String(message.chat.id), message.message_thread_id, senderId).run();
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Команда: /comp Фамилия или /comp Имя Фамилия" });
      return;
    }
    return;
  }
  const photoDatabaseTopic=await env.DB.prepare("SELECT style FROM secretary_photo_database_topics WHERE chat_id=? AND thread_id=?").bind(String(message.chat.id),message.message_thread_id).first<{style:"basic"|"fashion"}>();
  if(photoDatabaseTopic){
    if(!(await secretaryAllowed(env,senderId))){
      if(message.photo?.length||message.document) await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"У вас нет доступа к фотобазе. Попросите владельца или директора выдать права."});
      return;
    }
    if(message.media_group_id){await handleSecretaryAlbumMessage(env,message,senderId);return;}
    if(message.photo?.length||message.document){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Для обновления фотобазы отправьте все 7 фотографий одним альбомом и добавьте подпись «Имя Фамилия» к первому фото."});
    }
    return;
  }
  if (/^\/photo_check(?:@\w+)?$/i.test(command)) {
    if (!hasDirectorAccess(env, senderId)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, message_thread_id: message.message_thread_id,
        text: "Проверка доступна только владельцу или директору.",
      });
      return;
    }
    if (message.chat.type !== "supergroup") {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, text: "Проверку нужно запускать в супергруппе агентства.",
      });
      return;
    }
    try {
      const me = await telegram(env.SECRETARY_BOT_TOKEN, "getMe", {});
      const member = await telegram(env.SECRETARY_BOT_TOKEN, "getChatMember", {
        chat_id: message.chat.id, user_id: me.result.id,
      });
      const status = member.result?.status ?? "unknown";
      const canDelete = status === "creator" || (status === "administrator" && member.result?.can_delete_messages === true);
      const details = status === "administrator"
        ? (canDelete ? "can_delete_messages: да" : "can_delete_messages: нет")
        : status === "creator" ? "права создателя группы" : "не администратор";
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, message_thread_id: message.message_thread_id,
        text: "🔎 Проверка прав Secretary\\nСтатус: " + status + "\\n" + details + "\\n" +
          (canDelete
            ? "Бот имеет право удалять сообщения участников. Если фото остаются, проверим журнал ошибок удаления и ID сообщений."
            : "Бот может удалять свои сообщения, но не сообщения участников. Для удаления фотографий участников нужно включить право «Удаление сообщений»."),
      });
    } catch (error) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, message_thread_id: message.message_thread_id,
        text: "Не удалось проверить права Secretary: " + compositeErrorText(error).slice(0, 300),
      });
    }
    return;
  }  if (/^\/new(?:@\w+)?$/i.test(command)) {
    if (!hasDirectorAccess(env, senderId)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, message_thread_id: message.message_thread_id,
        text: "Создать фототеку может только владелец или директор.",
      });
      return;
    }
    await env.DB.prepare("INSERT INTO secretary_photo_topics (id, chat_id, thread_id, configured_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, thread_id=excluded.thread_id, configured_by=excluded.configured_by")
      .bind(String(message.chat.id), message.message_thread_id, senderId).run();
    const prompt = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id, message_thread_id: message.message_thread_id,
      text: "Тема MODEL BANK подключена. Напишите имя и фамилию модели, при желании добавив BASIC или FASHION. Если стиль не указан, бот предложит выбрать. Затем отправьте альбом из 7 фотографий.",
    });
    await env.DB.prepare("INSERT INTO secretary_photo_upload_sessions(chat_id,thread_id,uploader_id,command_message_id,prompt_message_id,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(chat_id,thread_id,uploader_id) DO UPDATE SET command_message_id=excluded.command_message_id,prompt_message_id=excluded.prompt_message_id,photo_message_ids_json='[]',bot_message_ids_json='[]',updated_at=CURRENT_TIMESTAMP")
      .bind(String(message.chat.id),message.message_thread_id,senderId,message.message_id,prompt.result?.message_id ?? null).run();
    return;
  }
  if (/^\/comp_setup(?:@\w+)?$/i.test(command)) {
    if (!hasDirectorAccess(env, senderId)) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Настроить фототеку может только владелец или директор." });
      return;
    }
    await env.DB.prepare("INSERT INTO secretary_photo_topics (id, chat_id, thread_id, configured_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, thread_id=excluded.thread_id, configured_by=excluded.configured_by")
      .bind(String(message.chat.id), message.message_thread_id, senderId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Тема MODEL BANK подключена. Напишите имя и фамилию модели, при желании добавив BASIC или FASHION. Если стиль не указан, бот предложит выбрать. Затем отправьте альбом из 7 фотографий." });
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
  if (!message.photo?.length && !message.document && command && !command.startsWith("/")) {
    const stylePrefix=command.match(/^(basic|fashion)\s+(.+)$/i);
    const styleSuffix=command.match(/^(.+?)\s+(basic|fashion)$/i);
    const requestedStyle=(stylePrefix?.[1]??styleSuffix?.[2])?.toLowerCase() as "basic"|"fashion"|undefined;
    const requestedName=(stylePrefix?.[2]??styleSuffix?.[1]??command).trim();
    const models=await getActiveModels(env);
    const matches=models.filter(m=>normalizeName(m.first_name+" "+m.last_name)===normalizeName(requestedName));
    if(matches.length!==1){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:matches.length?"Нашлось несколько анкет. Напишите имя и фамилию полностью.":"Модель «"+requestedName+"» не найдена. Проверьте имя и фамилию."});return;
    }
    await env.DB.prepare("INSERT INTO secretary_photo_upload_intents(chat_id,thread_id,uploader_id,model_id,style) VALUES(?,?,?,?,?) ON CONFLICT(chat_id,thread_id,uploader_id) DO UPDATE SET model_id=excluded.model_id,style=excluded.style,created_at=CURRENT_TIMESTAMP")
      .bind(String(message.chat.id),message.message_thread_id,senderId,matches[0].id,requestedStyle??null).run();
    if(requestedStyle){
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Принято: "+matches[0].first_name+" "+matches[0].last_name+" · "+requestedStyle.toUpperCase()+". Теперь отправьте одним альбомом ровно 7 фотографий."});
    }else{
      await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Для "+matches[0].first_name+" "+matches[0].last_name+" выберите стиль:",reply_markup:{inline_keyboard:[[{text:"BASIC",callback_data:"bank_intent_style:basic"},{text:"FASHION",callback_data:"bank_intent_style:fashion"}]]}});
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
    const matches = models.filter((m) => normalizeName(m.first_name + " " + m.last_name) === target);    if (matches.length !== 1) {
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: matches.length ? "Найдено несколько анкет с таким ФИО. Уточните данные в базе." : "Анкета «" + caption + "» не найдена. Проверьте ФИО." });
      return;
    }
    const model = matches[0];
    const initialPhotos = [{ file_id: bestPhoto.file_id, file_unique_id: bestPhoto.file_unique_id }];
    await trackSecretaryPhotoUploadMessages(env,message.chat.id,message.message_thread_id,senderId,{photoIds:[message.message_id]});
    await env.DB.prepare("INSERT INTO secretary_photo_batches (chat_id, thread_id, uploader_id, model_id, next_position, photos_json, updated_at) VALUES (?, ?, ?, ?, 2, ?, CURRENT_TIMESTAMP) ON CONFLICT(chat_id, thread_id, uploader_id) DO UPDATE SET model_id=excluded.model_id, next_position=2, photos_json=excluded.photos_json, updated_at=CURRENT_TIMESTAMP")
      .bind(String(message.chat.id), message.message_thread_id, senderId, model.id, JSON.stringify(initialPhotos)).run();
    const firstPrompt = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Принято: " + model.first_name + " " + model.last_name + ". Фото 1 из 7. Отправьте ещё шесть фото подряд." });
    if (firstPrompt.result?.message_id) await trackSecretaryPhotoUploadMessages(env,message.chat.id,message.message_thread_id,senderId,{botIds:[firstPrompt.result.message_id]});
    return;
  }
  const batch = await env.DB.prepare("SELECT model_id, next_position, photos_json FROM secretary_photo_batches WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND updated_at >= datetime('now', '-30 minutes')")
    .bind(String(message.chat.id), message.message_thread_id, senderId).first<{model_id:string;next_position:number;photos_json:string}>();
  if (!batch || batch.next_position < 2 || batch.next_position > 7) {
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Начните набор с первого фото и подписи «Имя Фамилия»." });
    return;
  }
  const stagedPhotos = JSON.parse(batch.photos_json) as Array<{file_id:string;file_unique_id:string}>;
  stagedPhotos.push({ file_id: bestPhoto.file_id, file_unique_id: bestPhoto.file_unique_id });
  await trackSecretaryPhotoUploadMessages(env,message.chat.id,message.message_thread_id,senderId,{photoIds:[message.message_id]});
  const next = batch.next_position + 1;
  await env.DB.prepare("UPDATE secretary_photo_batches SET next_position = ?, photos_json = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND thread_id = ? AND uploader_id = ?")
    .bind(next, JSON.stringify(stagedPhotos), String(message.chat.id), message.message_thread_id, senderId).run();
  const model = await env.DB.prepare("SELECT first_name, last_name FROM models WHERE id = ?").bind(batch.model_id).first<{first_name:string;last_name:string}>();
  if(next===8){
    await env.DB.prepare("INSERT INTO secretary_photo_replacement_pending(chat_id,thread_id,user_id,model_id,photos_json,style) VALUES(?,?,?,?,?,'basic') ON CONFLICT(chat_id,thread_id,user_id) DO UPDATE SET model_id=excluded.model_id,photos_json=excluded.photos_json,style='basic',created_at=CURRENT_TIMESTAMP").bind(String(message.chat.id),message.message_thread_id,senderId,batch.model_id,JSON.stringify(stagedPhotos)).run();
    await cleanupSecretaryPhotoUploadMessages(env,message.chat.id,message.message_thread_id,senderId);
    await env.DB.prepare("DELETE FROM secretary_photo_batches WHERE chat_id=? AND thread_id=? AND uploader_id=?").bind(String(message.chat.id),message.message_thread_id,senderId).run();
    await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Анкета "+(model?.first_name??"")+" "+(model?.last_name??"")+". Выберите набор фотографий:",reply_markup:{inline_keyboard:[[{text:"Basic",callback_data:"photo_style:basic"},{text:"Fashion",callback_data:"photo_style:fashion"}]]}});
  }else{
    const uploadReply=await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:message.chat.id,message_thread_id:message.message_thread_id,text:"Фото "+batch.next_position+" из 7 принято. Осталось "+(7-batch.next_position)+"."});
    if(uploadReply.result?.message_id)await trackSecretaryPhotoUploadMessages(env,message.chat.id,message.message_thread_id,senderId,{botIds:[uploadReply.result.message_id]});
  }
}
async function sendSecretaryCompositeSources(env: Env, chatId: number, model: SecretaryModelRow): Promise<void> {
  const result = await env.DB.prepare("SELECT position, telegram_file_id FROM model_telegram_photo_sets WHERE model_id = ? AND style = 'basic' ORDER BY position").bind(model.id).all<{position:number;telegram_file_id:string}>();
  const photos = result.results ?? [];
  if (photos.length !== 7 || photos.some((photo, index) => photo.position !== index + 1)) {
    await sendSecretary(env, chatId, secretaryProfileText(model).replace("Генерация графической композитки ещё подключается. Сейчас доступен поиск анкеты и её параметров.", "Фотографии ещё не загружены полностью. В теме «MODEL BANK» нужны семь снимков."));
    return;
  }
  await sendSecretary(env, chatId, secretaryProfileText(model));
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMediaGroup", {
    chat_id: chatId,
    media: photos.map((photo, index) => ({ type: "photo", media: photo.telegram_file_id, ...(index === 0 ? { caption: model.first_name + " " + model.last_name + " · фото 1/7" } : {}) })),
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
  const fileMatch = data.match(/^compfile:([a-zA-Z0-9_-]{1,50})$/);
  if (fileMatch) {
    const msg = callback.message;
    if (!msg || msg.chat.type !== "supergroup" || !msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Файл доступен только в теме композиток.", show_alert: true });
      return;
    }
    const topic = await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id=1")
      .first<{chat_id:string;thread_id:number}>();
    const publication = await env.DB.prepare(
      "SELECT model_id,photo_file_ids_json,model_snapshot_json,style,language FROM composite_topic_publications WHERE model_id=? AND chat_id=? AND thread_id=? AND message_id=?",
    ).bind(fileMatch[1], String(msg.chat.id), msg.message_thread_id, msg.message_id)
      .first<{model_id:string;photo_file_ids_json:string|null;model_snapshot_json:string|null;style:"basic"|"fashion";language:"ru"|"en"}>();
    if (!topic || topic.chat_id !== String(msg.chat.id) || topic.thread_id !== msg.message_thread_id || !publication) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Эта композитка уже заменена или недоступна.", show_alert: true });
      return;
    }
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Готовлю PNG-файл…" });
    try {
      let model: SecretaryModelRow | null = publication.model_snapshot_json
        ? JSON.parse(publication.model_snapshot_json) as SecretaryModelRow
        : null;
      if (!model) {
        model = await env.DB.prepare(
          `SELECT m.id,m.first_name,m.last_name,p.height_cm,p.bust_cm,p.waist_cm,p.hips_cm,
            p.clothing_size,p.shoe_size,p.hair_color,p.eye_color
           FROM models m LEFT JOIN model_profiles p ON p.model_id=m.id
           WHERE m.id=? AND m.is_active=1 AND m.lifecycle_status='active'`,
        ).bind(fileMatch[1]).first<SecretaryModelRow>();
      }
      if (!model) throw new Error("Анкета модели больше не активна.");
      let photoFileIds: string[] | null = publication.photo_file_ids_json
        ? JSON.parse(publication.photo_file_ids_json) as string[]
        : null;
      if (!photoFileIds) {
        const photoRows = await env.DB.prepare("SELECT position,telegram_file_id FROM model_telegram_photo_sets WHERE model_id=? AND style=? ORDER BY position")
          .bind(fileMatch[1],publication.style).all<{position:number;telegram_file_id:string}>();
        const photos = photoRows.results ?? [];
        if (photos.length !== 7 || photos.some((p,i)=>p.position!==i+1)) throw new Error("Исходные фотографии больше недоступны.");
        photoFileIds = photos.map(p=>p.telegram_file_id);
      }
      if (!Array.isArray(photoFileIds) || photoFileIds.length !== 7 || photoFileIds.some(id=>typeof id!=="string" || !id)) {
        throw new Error("Снимок исходных фотографий повреждён.");
      }
      const png = await renderCompositePng(env, model, photoFileIds, undefined, publication.language);
      const form = new FormData();
      form.set("chat_id", String(msg.chat.id));
      form.set("message_thread_id", String(msg.message_thread_id));
      form.set("caption", model.first_name + " " + model.last_name + " · оригинальный PNG");
      form.set("document", new Blob([png], {type:"image/png"}), "intermodels-composite.png");
      const response = await fetch(`https://api.telegram.org/bot${env.SECRETARY_BOT_TOKEN}/sendDocument`, {method:"POST",body:form});
      const result: any = await response.json().catch(()=>null);
      if (!response.ok || !result?.ok) throw new Error(result?.description ?? "Telegram не принял PNG.");
    } catch (error) {
      console.error("Composite original file delivery failed", {modelId:fileMatch[1],error:compositeErrorText(error)});
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {chat_id:msg.chat.id,message_thread_id:msg.message_thread_id,text:"Не удалось отправить PNG-файл. Ошибка записана в журнал."});
    }
    return;
  }
  const cancelMatch = data.match(/^op_cancel:([a-f0-9]{12})$/);
  if (cancelMatch) {
    const operationId = cancelMatch[1];
    const operation = await env.DB.prepare(
      "SELECT kind,source_key,status_message_id,intro_message_id,queue_message_id,input_message_id,result_chat_id,result_message_id,status,chat_id FROM secretary_operations WHERE id=? AND actor_id=?",
    ).bind(operationId, String(callback.from.id)).first<{
      kind:string;source_key:string|null;status_message_id:number|null;intro_message_id:number|null;queue_message_id:number|null;input_message_id:string|null;result_chat_id:string|null;result_message_id:number|null;status:string;chat_id:string;
    }>();
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
    if (cancelled && operation?.kind === "composite_batch") {
      await env.DB.prepare("UPDATE secretary_composite_batch_items SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE operation_id=? AND status='pending'")
        .bind(operationId).run();
    }
    if (cancelled && operation && (operation.kind === "composite" || operation.kind === "composite_batch")) {
      const resultChatId = operation.result_chat_id ?? operation.chat_id ?? String(callback.message?.chat.id ?? "");
      await deleteTelegramMessage(env, resultChatId, operation.result_message_id ?? undefined, "cancelled composite result");
      const statusMessageId = operation.status_message_id ?? callback.message?.message_id;
      await deleteTelegramMessage(env, resultChatId, statusMessageId ?? undefined, "cancelled composite status");
      if (operation.kind === "composite_batch") {
        await deleteTelegramMessage(env,resultChatId,operation.intro_message_id ?? undefined,"cancelled composite intro");
        await deleteTelegramMessage(env,resultChatId,operation.queue_message_id ?? undefined,"cancelled composite queue");
        if (operation.input_message_id) {
          try { for (const id of JSON.parse(operation.input_message_id) as number[]) await deleteTelegramMessage(env,resultChatId,id,"cancelled composite input"); } catch {}
        }
        await env.DB.prepare("UPDATE secretary_operations SET status_message_id=NULL,intro_message_id=NULL,queue_message_id=NULL,input_message_id=NULL,cleanup_at=NULL WHERE id=?")
          .bind(operationId).run();
      }
    } else if (cancelled && callback.message) {
      try {
        await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
          chat_id: callback.message.chat.id, message_id: callback.message.message_id,
          text: "⏹ Загрузка отменена. Незавершённый альбом очищен.",
          reply_markup: { inline_keyboard: [] },
        });
      } catch (error) { console.warn("Unable to update cancellation status message", compositeErrorText(error)); }
    }
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: cancelled ? "⏹ Отмена принята." :
        operation?.status === "publishing" ? "Публикация уже завершается — отменить её поздно." : "Операция уже завершена или недоступна.",
      show_alert: false,
    });
    if (!cancelled && operation?.status === "publishing" && callback.message) {
      try { await telegram(env.SECRETARY_BOT_TOKEN, "editMessageText", {
        chat_id: callback.message.chat.id, message_id: callback.message.message_id,
        text: "Публикация уже завершается…", reply_markup: { inline_keyboard: [] },
      }); } catch {}
    }
    return;
  }
  if (data === "photo:create") {
    if (!(await secretaryAllowed(env, String(callback.from.id)))) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Недостаточно прав для загрузки фотографий.", show_alert: true });
      return;
    }
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
    await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
    const prompt = await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
      text: "Начните новую фотоанкету: отправьте первое фото с подписью «Имя Фамилия», затем ещё шесть фото подряд (или одним альбомом из семи).",
    });
    await env.DB.prepare("INSERT INTO secretary_photo_upload_sessions(chat_id,thread_id,uploader_id,prompt_message_id,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(chat_id,thread_id,uploader_id) DO UPDATE SET command_message_id=NULL,prompt_message_id=excluded.prompt_message_id,photo_message_ids_json='[]',bot_message_ids_json='[]',updated_at=CURRENT_TIMESTAMP")
      .bind(String(msg.chat.id),msg.message_thread_id,String(callback.from.id),prompt.result?.message_id ?? null).run();
    return;
  }
  const bankIntentStyleMatch=data.match(/^bank_intent_style:(basic|fashion)$/);
  if(bankIntentStyleMatch){
    const msg=callback.message;
    if(!msg||msg.chat.type!=="supergroup"||!msg.message_thread_id){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Выбор доступен только в теме MODEL BANK.",show_alert:true});return;}
    const topic=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_photo_topics WHERE id=1").first<{chat_id:string;thread_id:number}>();
    const intent=await env.DB.prepare("SELECT model_id FROM secretary_photo_upload_intents WHERE chat_id=? AND thread_id=? AND uploader_id=?").bind(String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).first<{model_id:string}>();
    if(!topic||topic.chat_id!==String(msg.chat.id)||topic.thread_id!==msg.message_thread_id||!intent){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Запрос загрузки истёк. Напишите имя модели заново.",show_alert:true});return;}
    const style=bankIntentStyleMatch[1] as "basic"|"fashion";
    await env.DB.prepare("UPDATE secretary_photo_upload_intents SET style=?,created_at=CURRENT_TIMESTAMP WHERE chat_id=? AND thread_id=? AND uploader_id=?").bind(style,String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).run();
    const model=await env.DB.prepare("SELECT first_name,last_name FROM models WHERE id=?").bind(intent.model_id).first<{first_name:string;last_name:string}>();
    await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Стиль "+style.toUpperCase()+" выбран."});
    await telegram(env.SECRETARY_BOT_TOKEN,"editMessageText",{chat_id:msg.chat.id,message_id:msg.message_id,text:"Принято: "+(model?.first_name??"")+" "+(model?.last_name??"")+" · "+style.toUpperCase()+". Теперь отправьте одним альбомом ровно 7 фотографий.",reply_markup:{inline_keyboard:[]}});
    return;
  }
  const photoStyleMatch=data.match(/^photo_style:(basic|fashion)$/);
  if(photoStyleMatch){
    const msg=callback.message;if(!msg||msg.chat.type!=="supergroup"||!msg.message_thread_id){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Кнопка работает только в теме MODEL BANK.",show_alert:true});return;}
    const topic=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_photo_topics WHERE id=1").first<{chat_id:string;thread_id:number}>();
    if(!topic||topic.chat_id!==String(msg.chat.id)||topic.thread_id!==msg.message_thread_id){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Это не зарегистрированная тема MODEL BANK.",show_alert:true});return;}
    const pending=await env.DB.prepare("SELECT model_id,photos_json FROM secretary_photo_replacement_pending WHERE chat_id=? AND thread_id=? AND user_id=?").bind(String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).first<{model_id:string;photos_json:string}>();
    if(!pending){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Загрузка уже обработана или истекла.",show_alert:true});return;}
    const style=photoStyleMatch[1] as "basic"|"fashion";
    await env.DB.prepare("UPDATE secretary_photo_replacement_pending SET style=? WHERE chat_id=? AND thread_id=? AND user_id=?").bind(style,String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).run();
    await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:style==="basic"?"Выбран Basic.":"Выбран Fashion."});
    const photos=JSON.parse(pending.photos_json) as Array<{file_id:string;file_unique_id:string}>;
    await saveSecretaryPhotoSet(env,pending.model_id,photos,String(callback.from.id),msg.chat.id,msg.message_thread_id,style);
    let databasePublished=false;
    let publicationError:string|null=null;
    try{
      databasePublished=await publishSecretaryPhotoSetToDatabase(env,pending.model_id,style,msg.chat.id,msg.message_thread_id);
      if(!databasePublished)throw new Error("Тема PHOTO DATABASE не настроена или совпадает с MODEL BANK.");
    }catch(error){
      publicationError=compositeErrorText(error);
      console.error("Photo database mirror failed",{modelId:pending.model_id,style,error:publicationError});
    }
    if(databasePublished){
      await env.DB.prepare("DELETE FROM secretary_photo_replacement_pending WHERE chat_id=? AND thread_id=? AND user_id=?").bind(String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).run();
    }
    const model=await env.DB.prepare("SELECT first_name,last_name FROM models WHERE id=?").bind(pending.model_id).first<{first_name:string;last_name:string}>();
    await telegram(env.SECRETARY_BOT_TOKEN,"deleteMessage",{chat_id:msg.chat.id,message_id:msg.message_id});
    const resultText=databasePublished
      ? "Анкета "+(model?.first_name??"")+" "+(model?.last_name??"")+" готова✅ Фотографии сохранены и опубликованы в "+style.toUpperCase()+"."
      : "Фотографии "+(model?.first_name??"")+" "+(model?.last_name??"")+" сохранены в MODEL BANK, но не опубликованы в "+style.toUpperCase()+". Повторную публикацию можно запустить командой /photo_republish "+(model?.first_name??"")+" "+(model?.last_name??"")+" "+style.toUpperCase()+". Ошибка: "+(publicationError??"неизвестная ошибка").slice(0,220);
    await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:msg.chat.id,message_thread_id:msg.message_thread_id,text:resultText,reply_markup:{inline_keyboard:databasePublished?[[{text:"➕ Создать новую анкету",callback_data:"photo:create"}]]:[]}});return;
  }
  const compStyleMatch=data.match(/^comp_style:(basic|fashion)$/);
  if(compStyleMatch){
    const msg=callback.message;if(!msg||msg.chat.type!=="supergroup"||!msg.message_thread_id){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Выбор доступен только в теме «КОМПОЗИТКИ».",show_alert:true});return;}
    const topic=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id=1").first<{chat_id:string;thread_id:number}>();
    const pending=await env.DB.prepare("SELECT stage,mode FROM secretary_composite_request_pending WHERE chat_id=? AND thread_id=? AND user_id=? AND created_at>=datetime('now','-30 minutes')").bind(String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).first<{stage:string;mode:"single"|"batch"}>();
    if(!topic||topic.chat_id!==String(msg.chat.id)||topic.thread_id!==msg.message_thread_id||pending?.stage!=="style"){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Выбор стиля истёк. Запустите /comp ещё раз.",show_alert:true});return;}
    const style=compStyleMatch[1] as "basic"|"fashion";
    await env.DB.prepare("UPDATE secretary_composite_request_pending SET stage='language',style=? WHERE chat_id=? AND thread_id=? AND user_id=?").bind(style,String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).run();
    await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Стиль: "+(style==="basic"?"Basic":"Fashion")});
    await telegram(env.SECRETARY_BOT_TOKEN,"editMessageText",{chat_id:msg.chat.id,message_id:msg.message_id,text:"Стиль: "+(style==="basic"?"Basic":"Fashion")+". Теперь выберите язык:",reply_markup:{inline_keyboard:[[{text:"Русский",callback_data:"comp_lang:ru"},{text:"English",callback_data:"comp_lang:en"}]]}});return;
  }
  const compLanguageMatch=data.match(/^comp_lang:(ru|en)$/);
  if(compLanguageMatch){
    const msg=callback.message;if(!msg||msg.chat.type!=="supergroup"||!msg.message_thread_id){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Выбор доступен только в теме «КОМПОЗИТКИ».",show_alert:true});return;}
    const topic=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id=1").first<{chat_id:string;thread_id:number}>();
    const pending=await env.DB.prepare("SELECT stage,mode,style,names_text,command_message_id,prompt_message_id FROM secretary_composite_request_pending WHERE chat_id=? AND thread_id=? AND user_id=? AND created_at>=datetime('now','-30 minutes')").bind(String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).first<{stage:string;mode:"single"|"batch";style:"basic"|"fashion"|null;names_text:string|null;command_message_id:number|null;prompt_message_id:number|null}>();
    if(!topic||topic.chat_id!==String(msg.chat.id)||topic.thread_id!==msg.message_thread_id||pending?.stage!=="language"||!pending.style){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Выбор языка истёк. Запустите композитку ещё раз.",show_alert:true});return;}
    const language=compLanguageMatch[1] as "ru"|"en";
    await env.DB.prepare("UPDATE secretary_composite_request_pending SET stage='names',language=? WHERE chat_id=? AND thread_id=? AND user_id=?").bind(language,String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).run();
    await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:language==="ru"?"Русский выбран.":"English selected."});
    if(pending.names_text){
      const names=pending.names_text.split("\n").map(name=>name.trim()).filter(Boolean);
      if(!names.length||(pending.mode==="single"?names.length!==1:names.length>20)||names.some(name=>name.length>100)){await telegram(env.SECRETARY_BOT_TOKEN,"sendMessage",{chat_id:msg.chat.id,message_thread_id:msg.message_thread_id,text:pending.mode==="single"?"Команда /comp принимает только одну модель. Для списка используйте /comps.":"В списке должно быть от 1 до 20 моделей."});return;}
      await env.DB.prepare("DELETE FROM secretary_composite_request_pending WHERE chat_id=? AND thread_id=? AND user_id=?").bind(String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).run();
      await telegram(env.SECRETARY_BOT_TOKEN,"deleteMessage",{chat_id:msg.chat.id,message_id:msg.message_id});
      if(pending.prompt_message_id&&pending.prompt_message_id!==msg.message_id)await deleteTelegramMessage(env,msg.chat.id,pending.prompt_message_id,"composite options prompt");
      const sourceMessage={...msg,from:callback.from};const ids=[pending.command_message_id].filter((id):id is number=>typeof id==="number");
      if(pending.mode==="single"){
        if(pending.command_message_id)await deleteTelegramMessage(env,msg.chat.id,pending.command_message_id,"composite source name");
        await generateCompositeInTopic(env,sourceMessage,names[0],pending.style,language);
      }else await generateCompositeBatchInTopic(env,sourceMessage,names,ids,pending.style,language);
    }else{
      await telegram(env.SECRETARY_BOT_TOKEN,"editMessageText",{chat_id:msg.chat.id,message_id:msg.message_id,text:"Выбрано: "+(pending.style==="basic"?"Basic":"Fashion")+" · "+(language==="ru"?"Русский":"English")+". "+(pending.mode==="single"?"Отправьте ФИО одной модели.":"Отправьте от 1 до 20 моделей — по одной на строку."),reply_markup:{inline_keyboard:[]}});
      await env.DB.prepare("UPDATE secretary_composite_request_pending SET prompt_message_id=? WHERE chat_id=? AND thread_id=? AND user_id=?").bind(msg.message_id,String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).run();
    }
    return;
  }
  if (data === "photo_replace:yes" || data === "photo_replace:no") {
    const msg = callback.message;
    if (!msg || msg.chat.type !== "supergroup" || !msg.message_thread_id) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось определить тему.", show_alert: true });
      return;
    }
    const pendingPhotoSet = await env.DB.prepare(
      "SELECT model_id, photos_json, style FROM secretary_photo_replacement_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ?",
    ).bind(String(msg.chat.id), msg.message_thread_id, String(callback.from.id)).first<{model_id:string;photos_json:string;style:"basic"|"fashion"}>();
    if (!pendingPhotoSet) {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Запрос уже обработан или истёк.", show_alert: true });
      return;
    }
    if (data === "photo_replace:yes") {
      const newPhotos = JSON.parse(pendingPhotoSet.photos_json) as Array<{file_id:string;file_unique_id:string}>;
      if (newPhotos.length !== 7) {
        await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось прочитать новый комплект.", show_alert: true });
        return;
      }
      await saveSecretaryPhotoSet(env,pendingPhotoSet.model_id,newPhotos,String(callback.from.id),msg.chat.id,msg.message_thread_id,pendingPhotoSet.style);
      try{await publishSecretaryPhotoSetToDatabase(env,pendingPhotoSet.model_id,pendingPhotoSet.style,msg.chat.id,msg.message_thread_id);}catch(error){console.error("Photo database mirror failed",{modelId:pendingPhotoSet.model_id,style:pendingPhotoSet.style,error:compositeErrorText(error)});}
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Фотографии заменены." });
      const replacedModel = await env.DB.prepare("SELECT first_name,last_name FROM models WHERE id=?").bind(pendingPhotoSet.model_id).first<{first_name:string;last_name:string}>();
      await cleanupSecretaryPhotoUploadMessages(env,msg.chat.id,msg.message_thread_id,String(callback.from.id),[msg.message_id]);
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
        text: "Анкета " + (replacedModel?.first_name ?? "") + " " + (replacedModel?.last_name ?? "") + " готова✅",
        reply_markup: { inline_keyboard: [[{ text: "➕ Создать новую анкету", callback_data: "photo:create" }]] },
      });
    } else {
      await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Оставили прежние фотографии." });
      const keptModel = await env.DB.prepare("SELECT first_name,last_name FROM models WHERE id=?").bind(pendingPhotoSet.model_id).first<{first_name:string;last_name:string}>();
      await cleanupSecretaryPhotoUploadMessages(env,msg.chat.id,msg.message_thread_id,String(callback.from.id),[msg.message_id]);
      await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", {
        chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
        text: "Анкета " + (keptModel?.first_name ?? "") + " " + (keptModel?.last_name ?? "") + " готова✅",
        reply_markup: { inline_keyboard: [[{ text: "➕ Создать новую анкету", callback_data: "photo:create" }]] },
      });
    }
    await env.DB.prepare("DELETE FROM secretary_photo_replacement_pending WHERE chat_id = ? AND thread_id = ? AND user_id = ?")
      .bind(String(msg.chat.id), msg.message_thread_id, String(callback.from.id)).run();
    return;
  }
  if(data==="composite:create"){
    const msg=callback.message;if(!msg||msg.chat.type!=="supergroup"||!msg.message_thread_id){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Кнопка работает только в теме «КОМПОЗИТКИ».",show_alert:true});return;}
    const topic=await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id=1").first<{chat_id:string;thread_id:number}>();
    if(!topic||topic.chat_id!==String(msg.chat.id)||topic.thread_id!==msg.message_thread_id){await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Это не зарегистрированная тема композиток.",show_alert:true});return;}
    await env.DB.prepare("INSERT INTO secretary_composite_request_pending(chat_id,thread_id,user_id,stage) VALUES(?,?,?,'style') ON CONFLICT(chat_id,thread_id,user_id) DO UPDATE SET stage='style',style=NULL,language=NULL,names_text=NULL,command_message_id=NULL,prompt_message_id=NULL,created_at=CURRENT_TIMESTAMP").bind(String(msg.chat.id),msg.message_thread_id,String(callback.from.id)).run();
    await telegram(env.SECRETARY_BOT_TOKEN,"answerCallbackQuery",{callback_query_id:callback.id,text:"Выберите стиль."});
    await telegram(env.SECRETARY_BOT_TOKEN,"editMessageText",{chat_id:msg.chat.id,message_id:msg.message_id,text:"Выберите стиль композитки:",reply_markup:{inline_keyboard:[[{text:"Basic",callback_data:"comp_style:basic"},{text:"Fashion",callback_data:"comp_style:fashion"}]]}});return;
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

function hasDirectorAccess(env: Env, telegramId: string): boolean {
  return Boolean(telegramId) && (
    telegramId === env.OWNER_TELEGRAM_ID ||
    telegramId === env.DIRECTOR_TELEGRAM_ID
  );
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
input,select,button{box-sizing:border-box;width:100%;padding:11px;margin:5px 0;border-radius:9px;border:1px solid var(--im-border);background:var(--im-surface2);color:var(--im-text)}input::placeholder{color:var(--im-faint)}button{background:var(--im-accent);color:#101318;border:0;font-weight:650}button.secondary{background:transparent;color:var(--im-text);border:1px solid var(--im-border)}.person{display:flex;gap:10px;align-items:center;padding:11px 0;border-bottom:1px solid var(--im-border)}.person:last-child{border:0}.person.frozen{opacity:.52;filter:grayscale(1)}.person input{width:20px;height:20px;margin:0;flex:none}.person .meta{flex:1;min-width:0}.status{color:#38bdf8;font-size:12px;font-weight:700}.active{color:var(--im-accent)}
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
    home:['#dashboardHome','.im-greeting','#status','.im-metrics','.im-section'],    models:['#modelsPanel'],
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
async function publishCompositeModel(env:Env,campaignId:string|null,modelId:string,onStage?:(stage:string)=>Promise<void>,operationId?:string,style:"basic"|"fashion"="basic",language:"ru"|"en"="ru"):Promise<void>{
  const stage = async (value: string) => {
    await assertSecretaryOperationActive(env, operationId);
    await onStage?.(value);
  };
  await stage("Проверка темы публикации");
  const topic = await env.DB.prepare("SELECT chat_id,thread_id FROM secretary_composite_topics WHERE id = 1")
    .first<{ chat_id: string; thread_id: number }>();
  if (!topic) throw new Error("Тема «КОМПОЗИТКИ» не подключена.");
  await stage("Загрузка анкеты модели");
  const model = await env.DB.prepare(
    `SELECT m.id,m.first_name,m.last_name,p.height_cm,p.bust_cm,p.waist_cm,p.hips_cm,
      p.clothing_size,p.shoe_size,p.hair_color,p.eye_color
     FROM models m LEFT JOIN model_profiles p ON p.model_id=m.id
     WHERE m.id=? AND m.is_active=1 AND m.lifecycle_status='active'`,
  ).bind(modelId).first<SecretaryModelRow>();
  if (!model) throw new Error("Модель не найдена в активной базе.");
  await stage("Проверка фотографий модели");
  const result=await env.DB.prepare("SELECT position,telegram_file_id FROM model_telegram_photo_sets WHERE model_id=? AND style=? ORDER BY position").bind(modelId,style).all<{position:number;telegram_file_id:string}>();
  const photos=result.results??[];
  if(photos.length!==7||photos.some((photo,index)=>photo.position!==index+1))throw new Error("У модели отсутствует набор "+(style==="basic"?"Basic":"Fashion")+". Загрузите его в MODEL BANK.");
  const png=await renderCompositePng(env,model,photos.map(photo=>photo.telegram_file_id),stage,language);
  await stage("Отправка PNG в Telegram");
  const messageId = await sendCompositePng(env, Number(topic.chat_id), topic.thread_id, png, model.first_name + " " + model.last_name + " · InterModels", modelId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("Telegram не вернул ID новой композитки.");

  let publicationClaimed = false;
  if (operationId) {
    const recorded = await recordSecretaryOperationResult(env, operationId, Number(topic.chat_id), messageId);
    if (!recorded || !(await claimSecretaryOperationPublication(env, operationId))) {
      await deleteTelegramMessage(env, topic.chat_id, messageId, "cancelled batch composite before publication");
      throw new Error("SECRETARY_OPERATION_CANCELLED");
    }
    publicationClaimed = true;
  }

  let old: { chat_id: string; message_id: number } | null = null;
  try {

    old = await env.DB.prepare("SELECT chat_id,message_id FROM composite_topic_publications WHERE model_id=?")
    .bind(modelId).first<{ chat_id: string; message_id: number }>();
    await env.DB.prepare(
      `INSERT INTO composite_topic_publications(model_id,chat_id,thread_id,message_id,campaign_id,published_at,photo_file_ids_json,model_snapshot_json,style,language)
       VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?)
       ON CONFLICT(model_id) DO UPDATE SET chat_id=excluded.chat_id,thread_id=excluded.thread_id,
         message_id=excluded.message_id,campaign_id=excluded.campaign_id,published_at=CURRENT_TIMESTAMP,
         photo_file_ids_json=excluded.photo_file_ids_json,model_snapshot_json=excluded.model_snapshot_json,
         style=excluded.style,language=excluded.language`,
    ).bind(modelId, topic.chat_id, topic.thread_id, messageId, campaignId,
      JSON.stringify(photos.map((photo) => photo.telegram_file_id)), JSON.stringify(model), style, language).run();
    if (publicationClaimed) {
      await env.DB.prepare("UPDATE secretary_operations SET status='running',result_chat_id=NULL,result_message_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='publishing'")
        .bind(operationId).run();
    }
  } catch (error) {
    if (publicationClaimed) {
      await env.DB.prepare("UPDATE secretary_operations SET status='running',result_chat_id=NULL,result_message_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='publishing'")
        .bind(operationId).run();
    }
    await deleteTelegramMessage(env, topic.chat_id, messageId, "failed composite publication database commit");
    throw error;
  }
  if (old) {
    try {
      await telegram(env.SECRETARY_BOT_TOKEN, "deleteMessage", { chat_id: old.chat_id, message_id: old.message_id });
    } catch (error) {
      console.error("Old composite publication could not be deleted after new publication", { modelId, oldMessageId: old.message_id, error: compositeErrorText(error) });
    }
  }
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
      const previous=await env.DB.prepare("SELECT style,language FROM composite_topic_publications WHERE model_id=?").bind(job.model_id).first<{style:"basic"|"fashion";language:"ru"|"en"}>();
      await publishCompositeModel(env, job.campaign_id, job.model_id, onStage, undefined, previous?.style??"basic", previous?.language??"ru");
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
          catch (error) { console.error("Unable to send model freeze notice", { modelId: model.id, error: compositeErrorText(error) }); }        }
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
        ORDER BY x.message_id LIMIT 1) AS file_unique_id     FROM secretary_photo_album_items a
     GROUP BY a.chat_id, a.thread_id, a.uploader_id, a.media_group_id
     HAVING COUNT(*) = 7
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
        Boolean(update.message?.message_thread_id && update.message?.text && (update.message?.chat.type==="group"||update.message?.chat.type==="supergroup")) ||
        ["csel:", "composite:", "comp_style:", "comp_lang:", "photo_style:", "bank_intent_style:"].some((prefix) => (update.callback_query?.data ?? "").startsWith(prefix))
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
    ctx.waitUntil((async () => {
      await processRefreshCampaigns(env);
      await processCompositeRefreshJobs(env);
      await processSecretaryCompositeBatchJobs(env);
      await cleanupSecretaryCompositeBatchMessages(env);
      await processPendingSecretaryAlbums(env);
    })());
  },
};
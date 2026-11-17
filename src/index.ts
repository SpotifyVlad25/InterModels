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
interface TelegramUpdate { message?: TelegramMessage; callback_query?: TelegramCallbackQuery; }
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
    console.error("Telegram API error", method, result);
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
    "SELECT id, first_name, last_name, phone, telegram_user_id FROM models WHERE is_active = 1",
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
  // The owner receives visibility into new requests but no approval/rejection controls.
  if (env.OWNER_TELEGRAM_ID && env.OWNER_TELEGRAM_ID !== env.DIRECTOR_TELEGRAM_ID) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: env.OWNER_TELEGRAM_ID,
      text: message.replace("\n\nВыберите правильную анкету или отклоните заявку.", "\n\nСтатус: ожидает решения директора."),
      disable_web_page_preview: true,
    });
  }
  await sendModel(env, replyChatId, "Совпадение найдено. Заявка отправлена директору на проверку. Доступ откроется только после её подтверждения.", replyThreadId);
}

async function handleModelMessage(env: Env, message: TelegramMessage): Promise<void> {
  const user = message.from;
  if (!user || !["private", "group", "supergroup"].includes(message.chat.type)) return;
  const replyChatId = message.chat.id;
  const replyThreadId = message.message_thread_id;
  if (message.text?.startsWith("/start")) {
    await saveTopic(env, "model", message);
    await env.DB.prepare(
      `INSERT INTO bot_sessions (telegram_user_id, state, data_json, updated_at)
       VALUES (?, 'awaiting_name', '{}', CURRENT_TIMESTAMP)
       ON CONFLICT(telegram_user_id) DO UPDATE SET state = 'awaiting_name', data_json = '{}', updated_at = CURRENT_TIMESTAMP`,
    ).bind(String(user.id)).run();
    await telegram(env.MODEL_BOT_TOKEN, "sendMessage", {
      chat_id: replyChatId,
      ...(replyThreadId ? { message_thread_id: replyThreadId } : {}),
      text: "Добро пожаловать в InterModels!\n\nВведите имя и фамилию точно так, как они указаны в агентстве. Либо отправьте свой номер телефона кнопкой ниже.",
      reply_markup: { keyboard: [[{ text: "Поделиться контактом", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
    return;
  }
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
    await sendModel(env, req.telegram_user_id, `Добро пожаловать в InterModels, ${model.first_name}! Ваша регистрация подтверждена. Следующим этапом добавим заполнение параметров профиля.`);
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
  const isStaff = await hasStaffPermission(env, senderId, "profile.view");
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  if (!isDirector && !isOwner && !isStaff) {
    if (!isGroup) await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: `Доступ пока не подключён. Ваш Telegram ID: ${senderId}. Передайте его администратору InterModels для активации.` });
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
        reply_markup: { keyboard: [[{ text: "Открыть Mini App", web_app: { url: "https://intermodels.spotify-vlad25.workers.dev/app" } }]], resize_keyboard: true },
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
  const result = await env.DB.prepare(
    `SELECT m.id, m.first_name, m.last_name,
      p.height_cm, p.bust_cm, p.waist_cm, p.hips_cm,
      p.clothing_size, p.shoe_size, p.hair_color, p.eye_color
     FROM models m LEFT JOIN model_profiles p ON p.model_id = m.id
     WHERE m.is_active = 1 AND lower(m.last_name) LIKE lower(?)
     ORDER BY m.last_name, m.first_name LIMIT 20`,
  ).bind(`%${surname}%`).all<SecretaryModelRow>();
  return result.results ?? [];
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
  const photo = message.photo?.[message.photo.length - 1];
  if (!photo) return;
  const caption = (message.caption ?? "").trim();
  let modelId: string | null = null;
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
    modelId = matches[0].id;
  } else {
    const existing = await env.DB.prepare(
      "SELECT model_id FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? AND model_id IS NOT NULL LIMIT 1",
    ).bind(String(message.chat.id), message.message_thread_id, senderId, albumId).first<{model_id:string}>();
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
  ).bind(String(message.chat.id), message.message_thread_id, senderId, albumId, message.message_id, modelId, photo.file_id, photo.file_unique_id).run();
  if (modelId) {
    await env.DB.prepare(
      "UPDATE secretary_photo_album_items SET model_id = ? WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? AND model_id IS NULL",
    ).bind(modelId, String(message.chat.id), message.message_thread_id, senderId, albumId).run();
  }
  const album = await env.DB.prepare(
    "SELECT message_id, model_id, telegram_file_id AS file_id, telegram_file_unique_id AS file_unique_id FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ? ORDER BY message_id",
  ).bind(String(message.chat.id), message.message_thread_id, senderId, albumId)
    .all<{message_id:number;model_id:string|null;file_id:string;file_unique_id:string}>();
  const items = album.results ?? [];
  if (items.length > 4) {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), message.message_thread_id, senderId, albumId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "В альбоме должно быть ровно 4 фотографии. Отправьте комплект заново." });
    return;
  }
  if (items.length !== 4 || items.some((item) => !item.model_id)) return;
  const resolvedModelId = items[0].model_id!;
  if (items.some((item) => item.model_id !== resolvedModelId)) {
    await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
      .bind(String(message.chat.id), message.message_thread_id, senderId, albumId).run();
    await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "У фотографий альбома должно быть одно ФИО в подписи первого снимка. Отправьте комплект заново." });
    return;
  }
  await saveSecretaryPhotoSet(env, resolvedModelId, items.map(({file_id,file_unique_id}) => ({file_id,file_unique_id})), senderId, message.chat.id, message.message_thread_id);
  await env.DB.prepare("DELETE FROM secretary_photo_album_items WHERE chat_id = ? AND thread_id = ? AND uploader_id = ? AND media_group_id = ?")
    .bind(String(message.chat.id), message.message_thread_id, senderId, albumId).run();
  const model = await env.DB.prepare("SELECT first_name, last_name FROM models WHERE id = ?").bind(resolvedModelId).first<{first_name:string;last_name:string}>();
  await telegram(env.SECRETARY_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "Готово: альбом из 4 фотографий для " + (model?.first_name ?? "") + " " + (model?.last_name ?? "") + " сохранён в правильном порядке." });
}
async function handleSecretaryGroupMessage(env: Env, message: TelegramMessage): Promise<void> {
  if (!message.from || (message.chat.type !== "group" && message.chat.type !== "supergroup") || !message.message_thread_id) return;
  const senderId = String(message.from.id);
  const command = (message.text ?? "").trim();
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
  const match = (callback.data ?? "").match(/^comp:([a-zA-Z0-9_-]{1,50})$/);
  if (!match || !callback.message || callback.message.chat.type !== "private") {
    await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось выбрать анкету." });
    return;
  }
  const model = await env.DB.prepare(
    `SELECT m.id, m.first_name, m.last_name,
      p.height_cm, p.bust_cm, p.waist_cm, p.hips_cm,
      p.clothing_size, p.shoe_size, p.hair_color, p.eye_color
     FROM models m LEFT JOIN model_profiles p ON p.model_id = m.id
     WHERE m.id = ? AND m.is_active = 1`,
  ).bind(match[1]).first<SecretaryModelRow>();
  await telegram(env.SECRETARY_BOT_TOKEN, "answerCallbackQuery", {
    callback_query_id: callback.id, text: model ? "Модель выбрана." : "Анкета не найдена.",
  });
  if (model) await sendSecretaryCompositeSources(env, callback.message.chat.id, model);
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
  const html = "<!doctype html><html lang='ru'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>InterModels</title><script src='https://telegram.org/js/telegram-web-app.js'></script><style>body{font:16px system-ui;margin:0;padding:18px;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}h1{font-size:22px}.panel{background:var(--tg-theme-secondary-bg-color,#eee);padding:14px;border-radius:14px;margin:14px 0}input,select,button{box-sizing:border-box;width:100%;padding:11px;margin:5px 0;border-radius:9px;border:1px solid #999;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}button{background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff);border:0}.perm{display:block;margin:8px 0}.perm input{width:auto}.person{padding:10px 0;border-bottom:1px solid #aaa}.person button{background:#a33}.muted{opacity:.7;font-size:13px}</style></head><body><h1>InterModels</h1><div class='muted'>Управление доступом помощников</div><section class='panel'><h3>Выдать доступ</h3><input id='uid' inputmode='numeric' placeholder='Telegram ID помощника'><input id='name' placeholder='Имя (необязательно)'><select id='role'><option value='helper'>Помощник</option><option value='viewer'>Наблюдатель</option></select><div id='perms'><label class='perm'><input type='checkbox' value='profile.view' checked> Просмотр анкет</label><label class='perm'><input type='checkbox' value='profile.edit'> Редактирование анкет</label><label class='perm'><input type='checkbox' value='photos.manage'> Управление фотографиями</label><label class='perm'><input type='checkbox' value='composite.generate'> Создание композиток</label><label class='perm'><input type='checkbox' value='requests.manage'> Решение заявок</label></div><button id='grant'>Выдать права</button></section><section class='panel'><h3>Действующие доступы</h3><div id='staff'>Загрузка…</div></section><div id='status'></div><script>const tg=window.Telegram?.WebApp;tg?.ready();tg?.expand();const initData=tg?.initData||'';const st=document.getElementById('status');async function api(m,p,b){const r=await fetch(p,{method:m,headers:{Authorization:'tma '+initData,'Content-Type':'application/json'},...(b?{body:JSON.stringify(b)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'Ошибка');return d}async function load(){try{const d=await api('GET','/api/director/staff');const root=document.getElementById('staff');root.innerHTML='';if(!d.staff.length){root.textContent='Помощники пока не добавлены.';return}for(const p of d.staff){const el=document.createElement('div');el.className='person';const title=document.createElement('strong');title.textContent=(p.display_name||'Без имени')+' · '+p.telegram_user_id;const info=document.createElement('div');info.className='muted';info.textContent=p.role+' · '+p.permissions.join(', ');const btn=document.createElement('button');btn.textContent='Отозвать доступ';btn.onclick=async()=>{try{await api('DELETE','/api/director/staff?telegram_user_id='+encodeURIComponent(p.telegram_user_id));await load()}catch(e){st.textContent=e.message}};el.append(title,info,btn);root.append(el)}}catch(e){st.textContent=e.message;document.getElementById('staff').textContent='Не удалось загрузить список.'}}document.getElementById('grant').onclick=async()=>{try{const id=document.getElementById('uid').value.trim(),permissions=[...document.querySelectorAll('#perms input:checked')].map(x=>x.value);await api('POST','/api/director/staff',{telegram_user_id:id,display_name:document.getElementById('name').value.trim(),role:document.getElementById('role').value,permissions});st.textContent='Доступ сохранён.';document.getElementById('uid').value='';await load()}catch(e){st.textContent=e.message}};load();</script></body></html>";
  return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'self' https://telegram.org; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org"}});
}
async function handleDirectorApi(request: Request, env: Env, url: URL): Promise<Response> {
  const actor=await miniAppActor(request,env);
  if(!actor) return json({error:"Недействительная или устаревшая авторизация Telegram."},401);
  if(!(await actorHasPermission(env,actor.id,"staff.manage"))) return json({error:"Недостаточно прав."},403);
  if(url.pathname!=="/api/director/staff") return json({error:"Not found"},404);
  if(request.method==="GET"){
    const result=await env.DB.prepare("SELECT telegram_user_id,display_name,role,permissions_json,is_active FROM agency_staff_access ORDER BY created_at DESC").all<{telegram_user_id:string;display_name:string|null;role:string;permissions_json:string;is_active:number}>();
    const staff=(result.results??[]).map(row=>{let permissions:string[]=[];try{permissions=Object.keys(JSON.parse(row.permissions_json)).filter(k=>STAFF_PERMISSIONS.includes(k as StaffPermission))}catch{}return{telegram_user_id:row.telegram_user_id,display_name:row.display_name,role:row.role,permissions,is_active:row.is_active===1}});
    return json({ok:true,staff});
  }
  if(request.method==="POST"){
    let body:any;try{body=await request.json()}catch{return json({error:"Некорректный JSON."},400)}
    const id=String(body?.telegram_user_id??"").trim(),role=body?.role,displayName=typeof body?.display_name==="string"?body.display_name.trim().slice(0,100):null;
    const permissions: string[]=Array.isArray(body?.permissions)?Array.from(new Set<string>(body.permissions.filter((p:unknown)=>typeof p==="string").map((p:unknown)=>String(p)))):[];
    if(!/^[0-9]{5,20}$/.test(id)||!["helper","viewer"].includes(role)||permissions.some((p)=>!STAFF_PERMISSIONS.includes(p as StaffPermission)||p==="staff.manage")) return json({error:"Проверьте Telegram ID, роль и разрешения."},400);
    if(id===env.OWNER_TELEGRAM_ID||id===env.DIRECTOR_TELEGRAM_ID)return json({error:"Нельзя менять доступ владельца или директора."},400);
    if(role==="viewer"&&permissions.some((p:string)=>p!=="profile.view"))return json({error:"Наблюдателю доступен только просмотр."},400);
    await env.DB.prepare("INSERT INTO agency_staff_access(telegram_user_id,display_name,role,permissions_json,granted_by) VALUES(?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,permissions_json=excluded.permissions_json,is_active=1,granted_by=excluded.granted_by,updated_at=CURRENT_TIMESTAMP").bind(id,displayName,role,JSON.stringify(Object.fromEntries(permissions.map((p:string)=>[p,true]))),actor.id).run();
    await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'staff.grant', ?)").bind(randomId(),actor.id,JSON.stringify({telegram_user_id:id,role,permissions})).run();
    return json({ok:true});
  }
  if(request.method==="DELETE"){
    const id=(url.searchParams.get("telegram_user_id")??"").trim();
    if(!/^[0-9]{5,20}$/.test(id)||id===env.OWNER_TELEGRAM_ID||id===env.DIRECTOR_TELEGRAM_ID)return json({error:"Некорректный или защищённый Telegram ID."},400);
    await env.DB.prepare("UPDATE agency_staff_access SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE telegram_user_id=?").bind(id).run();
    await env.DB.prepare("INSERT INTO agency_audit_log(id,actor_telegram_id,action,details_json) VALUES(?,?, 'staff.revoke', ?)").bind(randomId(),actor.id,JSON.stringify({telegram_user_id:id})).run();
    return json({ok:true});
  }
  return json({error:"Method not allowed"},405);
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
};
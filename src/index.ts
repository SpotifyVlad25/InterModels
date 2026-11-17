interface Env {
  DB: D1Database;
  MODEL_BOT_TOKEN: string;
  DIRECTOR_BOT_TOKEN: string;
  DIRECTOR_TELEGRAM_ID: string;
  OWNER_TELEGRAM_ID: string;
  MODEL_WEBHOOK_SECRET: string;
  DIRECTOR_WEBHOOK_SECRET: string;
}
interface TelegramUser { id: number; first_name?: string; last_name?: string; username?: string; }
interface TelegramMessage {
  message_id: number; message_thread_id?: number; from?: TelegramUser; chat: { id: number; type: string };
  text?: string; contact?: { phone_number: string; user_id?: number };
}
interface TelegramCallbackQuery { id: string; from: TelegramUser; data?: string; message?: TelegramMessage; }
interface TelegramUpdate { message?: TelegramMessage; callback_query?: TelegramCallbackQuery; }
interface ModelRow { id: string; first_name: string; last_name: string; phone: string | null; telegram_user_id: string | null; }
interface RegistrationRow { id: string; telegram_user_id: string; candidate_model_ids: string; status: string; }

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
  const message = `Новая заявка на подключение InterModels\n\nПользователь: ${user.first_name ?? ""} ${user.last_name ?? ""} (${userLabel})\nTelegram ID: ${user.id}\nСпособ поиска: ${method === "name" ? "ФИО" : "телефон"}\nВведённые данные: ${submittedValue}\n\nНайденные анкеты:\n${candidateLines}\n\nВыберите правильную анкету или отклоните заявку.`;
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
async function handleDirectorCallback(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  if (String(callback.from.id) !== env.DIRECTOR_TELEGRAM_ID) {
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
  if (!message.from || message.chat.type !== "private") return;
  const senderId = String(message.from.id);
  const isDirector = senderId === env.DIRECTOR_TELEGRAM_ID;
  const isOwner = Boolean(env.OWNER_TELEGRAM_ID) && senderId === env.OWNER_TELEGRAM_ID;
  if (!isDirector && !isOwner) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "Доступ к этому боту ограничен." });
    return;
  }
  if (message.text?.startsWith("/start")) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: isDirector
        ? "InterModels Director подключён. У вас полный доступ к решениям по заявкам."
        : "InterModels Owner подключён. Вы можете получать уведомления и контролировать заявки. Решения по заявкам принимает директор.",
    });
  } else if (message.text?.startsWith("/help")) {
    await telegram(env.DIRECTOR_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: isDirector
        ? "Команды:\n/start — подключить бота\n/help — помощь\n\nВы можете принимать и отклонять заявки."
        : "Команды:\n/start — подключить бота\n/help — помощь\n\nУ вас доступ к уведомлениям. Подтверждать и отклонять заявки может только директор.",
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "intermodels" });
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    const isModel = url.pathname === "/webhook/model";
    const isDirector = url.pathname === "/webhook/director";
    if (!isModel && !isDirector) return json({ error: "Not found" }, 404);
    const secret = isModel ? env.MODEL_WEBHOOK_SECRET : env.DIRECTOR_WEBHOOK_SECRET;
    if (!secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return json({ error: "Unauthorized" }, 401);
    let update: TelegramUpdate;
    try { update = await request.json() as TelegramUpdate; }
    catch { return json({ error: "Invalid JSON" }, 400); }
    try {
      if (isModel && update.message) await handleModelMessage(env, update.message);
      if (isDirector && update.message) await handleDirectorMessage(env, update.message);
      if (isDirector && update.callback_query) await handleDirectorCallback(env, update.callback_query);
      return json({ ok: true });
    } catch (error) {
      console.error("Webhook handler failed", error);
      return json({ ok: false }, 500);
    }
  },
};

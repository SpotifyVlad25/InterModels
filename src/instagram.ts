import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import cyrillic from "@fontsource/roboto/files/roboto-cyrillic-400-normal.woff2";
import latin from "@fontsource/roboto/files/roboto-latin-400-normal.woff2";

type Env = { DB: D1Database; INST_BOT_TOKEN: string; OWNER_TELEGRAM_ID?: string };
type Photo = { file_id: string; file_unique_id: string; width: number; height: number };
type Message = {
  message_id: number; message_thread_id?: number; media_group_id?: string;
  chat: { id: number; type: string }; from?: { id: number; first_name?: string };
  text?: string; caption?: string; photo?: Photo[];
};
type CallbackQuery = { id: string; from: { id: number }; data?: string; message?: Message };
type Update = { message?: Message; callback_query?: CallbackQuery; };
type Category = "FASHION_HELLO" | "FASHION" | "КАТАЛОГ" | "ТЕСТЫ" | "ЭМОЦИИ" | "БЬЮТИ" | "ANY";
const categories: Category[] = ["FASHION", "КАТАЛОГ", "ТЕСТЫ", "ЭМОЦИИ", "БЬЮТИ"];
const topicNames = ["greeting", "album", "plan", "generator"] as const;
let wasmReady: Promise<void> | undefined;

async function api(env: Env, method: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch("https://api.telegram.org/bot" + env.INST_BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j: any = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.description || "Telegram " + method + " failed");
  return j.result;
}
async function send(env: Env, m: Message, text: string): Promise<void> {
  await api(env, "sendMessage", { chat_id: m.chat.id, ...(m.message_thread_id ? { message_thread_id: m.message_thread_id } : {}), text });
}
function key(m: Message): { chat: string; thread: number } {
  return { chat: String(m.chat.id), thread: m.message_thread_id ?? 0 };
}
function dayKey(): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Yekaterinburg", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = (t: string) => p.find(x => x.type === t)?.value ?? "00";
  return v("year") + "-" + v("month") + "-" + v("day");
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function downloadPhoto(env: Env, fileId: string): Promise<Uint8Array> {
  const f = await api(env, "getFile", { file_id: fileId });
  const r = await fetch("https://api.telegram.org/file/bot" + env.INST_BOT_TOKEN + "/" + f.file_path);
  if (!r.ok) throw new Error("Не удалось скачать фото.");
  return new Uint8Array(await r.arrayBuffer());
}
function wrap(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = (line ? line + " " : "") + word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
type StoryRenderOptions = { position?: "1" | "2" | "3" | "4" | "5"; fill?: "white" | "black" | "trans_black" | "trans_white" | "pink"; mode?: "pill" | "full" };
async function render(photo: Uint8Array, text: string, style: number, options: StoryRenderOptions = {}): Promise<Uint8Array> {
  wasmReady ??= initWasm(wasm); await wasmReady;
  const fontBuffers = [new Uint8Array(cyrillic), new Uint8Array(latin)];
  const position = options.position ?? "3";
  const fill = options.fill ?? (style === 0 ? "trans_black" : "trans_white");
  const mode = options.mode ?? "pill";
  const zoneHeight = 384;
  const zoneY = (Number(position) - 1) * zoneHeight;
  const lines = text.trim() ? wrap(text, 22) : [];
  const paddingY = 34;
  const fittedSize = lines.length ? Math.floor((zoneHeight - paddingY * 2) / (lines.length * 1.2)) : 70;
  const size = Math.max(30, Math.min(70, fittedSize));
  const lineHeight = Math.round(size * 1.2);
  const textHeight = lines.length * lineHeight;
  const panelHeight = Math.min(zoneHeight, textHeight + paddingY * 2);
  const panelY = zoneY + Math.round((zoneHeight - panelHeight) / 2);
  const firstBaseline = mode === "full"
    ? zoneY + Math.round((zoneHeight - textHeight) / 2) + Math.round(size * 0.9)
    : panelY + paddingY + Math.round(size * 0.9);
  // Keep equal side margins and natural word spacing; align every line to the left.
  const textX = 72;
  const tspans = lines.map((line, i) =>
    '<tspan x="' + textX + '" dy="' + (i ? lineHeight : 0) + '">' + esc(line) + "</tspan>"
  ).join("");
  const fills: Record<string, { background: string; foreground: string }> = {
    white: { background: "#FFFFFF", foreground: "#171717" },
    black: { background: "#000000", foreground: "#FFFFFF" },
    trans_black: { background: "rgba(0,0,0,.58)", foreground: "#FFFFFF" },
    trans_white: { background: "rgba(255,255,255,.68)", foreground: "#171717" },
    pink: { background: "#E88FB4", foreground: "#FFFFFF" },
  };
  const palette = fills[fill] ?? fills.trans_black;
  const panelX = mode === "full" ? 0 : 48;
  const panelWidth = mode === "full" ? 1080 : 984;
  const actualPanelY = mode === "full" ? zoneY : panelY;
  const actualPanelHeight = mode === "full" ? zoneHeight : panelHeight;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1920"><image width="1080" height="1920" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/jpeg;base64,' + b64(photo) + '"/>' +
    (lines.length ? '<rect x="' + panelX + '" y="' + actualPanelY + '" width="' + panelWidth + '" height="' + actualPanelHeight + '" rx="' + (mode === "full" ? 0 : 22) + '" fill="' + palette.background + '"/><text x="' + textX + '" y="' + firstBaseline + '" text-anchor="start" fill="' + palette.foreground + '" font-family="Roboto" font-size="' + size + '" font-weight="400">' + tspans + "</text>" : "") + "</svg>";
  return new Resvg(svg, { fitTo: { mode: "width", value: 1080 }, font: { fontBuffers, defaultFontFamily: "Roboto", sansSerifFamily: "Roboto" } }).render().asPng();
}
async function publish(env: Env, m: Message, images: Uint8Array[]): Promise<void> {
  const form = new FormData();
  form.set("chat_id", String(m.chat.id));
  if (m.message_thread_id) form.set("message_thread_id", String(m.message_thread_id));
  if (images.length === 1) {
    form.set("photo", new Blob([images[0]], { type: "image/png" }), "story.png");
    const single = await fetch("https://api.telegram.org/bot" + env.INST_BOT_TOKEN + "/sendPhoto", { method: "POST", body: form });
    const singleResult: any = await single.json();
    if (!single.ok || !singleResult.ok) throw new Error(singleResult.description || "Не удалось отправить Story.");
    return;
  }
  form.set("media", JSON.stringify(images.map((_, i) => ({ type: "photo", media: "attach://story" + i + ".png" }))));
  images.forEach((v, i) => form.set("story" + i + ".png", new Blob([v], { type: "image/png" }), "story" + i + ".png"));
  const r = await fetch("https://api.telegram.org/bot" + env.INST_BOT_TOKEN + "/sendMediaGroup", { method: "POST", body: form });
  const j: any = await r.json(); if (!r.ok || !j.ok) throw new Error(j.description || "Не удалось отправить Stories.");
}
async function answerInstagramCallback(env: Env, callback: CallbackQuery, text: string): Promise<void> {
  await api(env, "answerCallbackQuery", { callback_query_id: callback.id, text });
}
function storyKeyboard(id: string, stage: "position" | "fill" | "mode"): Record<string, unknown> {
  if (stage === "position") return { inline_keyboard: [
    [{ text: "1 · Самый верх", callback_data: "story:" + id + ":pos:1" }],
    [{ text: "2", callback_data: "story:" + id + ":pos:2" }, { text: "3 · Центр", callback_data: "story:" + id + ":pos:3" }],
    [{ text: "4", callback_data: "story:" + id + ":pos:4" }, { text: "5 · Самый низ", callback_data: "story:" + id + ":pos:5" }],
  ] };
  if (stage === "fill") return { inline_keyboard: [
    [{ text: "Белый", callback_data: "story:" + id + ":fill:white" }, { text: "Чёрный", callback_data: "story:" + id + ":fill:black" }],
    [{ text: "Прозрачный чёрный", callback_data: "story:" + id + ":fill:trans_black" }],
    [{ text: "Прозрачный белый", callback_data: "story:" + id + ":fill:trans_white" }],
    [{ text: "Розовый", callback_data: "story:" + id + ":fill:pink" }],
  ] };
  return { inline_keyboard: [[
    { text: "Плашка", callback_data: "story:" + id + ":mode:pill" },
    { text: "Полная заливка", callback_data: "story:" + id + ":mode:full" },
  ]] };
}
async function editStoryPrompt(env: Env, callback: CallbackQuery, text: string, markup: Record<string, unknown>): Promise<void> {
  const msg = callback.message!;
  await api(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text, reply_markup: markup });
}
async function handleStoryStyleCallback(env: Env, callback: CallbackQuery): Promise<void> {
  const match = (callback.data ?? "").match(/^story:([a-f0-9]{12}):(pos|fill|mode):(1|2|3|4|5|white|black|trans_black|trans_white|pink|pill|full)$/);
  if (!match || !callback.message) { await answerInstagramCallback(env, callback, "Эта кнопка устарела."); return; }
  const [, id, action, value] = match;
  // Acknowledge immediately so Telegram does not leave the button spinner running
  // while D1 and message-edit requests are processed.
  try {
    await answerInstagramCallback(env, callback, "Обрабатываю выбор…");
  } catch (error) {
    // Callback acknowledgement can expire while Telegram retries a queued update.
    // Do not let that prevent the actual selection from being processed.
    console.warn("Instagram callback acknowledgement failed", {
      callbackId: callback.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
  const row = await env.DB.prepare("SELECT chat_id,thread_id,user_id,stage,photo_file_id,story_text,position,fill FROM instagram_story_style_pending WHERE id=?")
    .bind(id).first<{ chat_id:string; thread_id:number; user_id:string; stage:string; photo_file_id:string; story_text:string; position:string|null; fill:string|null }>();
  if (!row || row.user_id !== String(callback.from.id) || row.chat_id !== String(callback.message.chat.id) || row.thread_id !== (callback.message.message_thread_id ?? 0) || row.stage !== (action === "pos" ? "position" : action)) {
    await editStoryPrompt(env, callback, "Эта настройка уже обработана или устарела. Отправь фотографию ещё раз, чтобы начать заново.", { inline_keyboard: [] });
    return;
  }
  if (action === "pos") {
    await env.DB.prepare("UPDATE instagram_story_style_pending SET position=?,stage='fill',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(value,id).run();
    await editStoryPrompt(env, callback, "Шаг 2/3. Выбери цвет заливки:", storyKeyboard(id,"fill"));
    return;
  }  if (action === "fill") {
    await env.DB.prepare("UPDATE instagram_story_style_pending SET fill=?,stage='mode',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(value,id).run();
    await editStoryPrompt(env, callback, "Шаг 3/3. Выбери вид заливки:", storyKeyboard(id,"mode"));
    return;
  }  try {
    // Show immediate progress so a slow download/render never looks like a dead button.
    await editStoryPrompt(env, callback, "⏳ Выбор принят. Скачиваю фотографию…", { inline_keyboard: [] });
    const photo = await downloadPhoto(env, row.photo_file_id);
    await editStoryPrompt(env, callback, "⏳ Фото получено. Накладываю текст и готовлю Story…", { inline_keyboard: [] });
    const image = await render(photo, row.story_text, 0, {
      position: row.position as "1"|"2"|"3"|"4"|"5",
      fill: row.fill as "white"|"black"|"trans_black"|"trans_white"|"pink",
      mode: value as "pill"|"full",
    });
    await publish(env, callback.message, [image]);
    await env.DB.prepare("DELETE FROM instagram_story_style_pending WHERE id=?").bind(id).run();
    await editStoryPrompt(env, callback, "✓ Готово! Story отправлена. Для следующей фотографии отправь фото с текстом.", { inline_keyboard: [] });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("Instagram Story style render failed", { id, reason });
    await editStoryPrompt(env, callback, "❌ Не удалось обработать фото: " + reason.slice(0,300), { inline_keyboard: [] });
    await env.DB.prepare("DELETE FROM instagram_story_style_pending WHERE id=?").bind(id).run();
  }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("Instagram Story style callback failed", { id, action, value, reason });
    try {
      await editStoryPrompt(env, callback, "❌ Не удалось применить настройку: " + reason.slice(0, 250), { inline_keyboard: [] });
    } catch (editError) {
      console.error("Instagram Story callback error message failed", {
        id,
        reason: editError instanceof Error ? editError.message : String(editError),
      });
    }
  }
}
async function savePhoto(env: Env, m: Message, category: Category): Promise<void> {
  const p = m.photo?.[m.photo.length - 1]; if (!p) return;
  const k = key(m), uploader = String(m.from?.id ?? 0), day = dayKey();
  await env.DB.prepare(
    "INSERT INTO instagram_upload_context(chat_id,thread_id,uploader_id,day_key,media_group_id,category,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(chat_id,thread_id,uploader_id,day_key) DO UPDATE SET media_group_id=excluded.media_group_id,category=excluded.category,updated_at=CURRENT_TIMESTAMP",
  ).bind(k.chat, k.thread, uploader, day, m.media_group_id ?? null, category).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO instagram_photos(chat_id,thread_id,category,telegram_file_id,file_unique_id,uploaded_by,day_key,source_message_id) VALUES(?,?,?,?,?,?,?,?)",
  ).bind(k.chat, k.thread, category, p.file_id, p.file_unique_id, uploader, day, m.message_id).run();
}
async function processPlanItem(env: Env, m: Message): Promise<void> {
  const k = key(m), day = dayKey();
  let body = (m.text ?? "").trim().replace(/^\d+[.)]\s*/, "").trim();
  const cat = body.match(/\(([ФЭКБТ])\)\s*$/i);
  body = body.replace(/\s*\([ФЭКБТ]\)\s*$/i, "").trim();
  const categoryMap: Record<string, Category> = { "Ф": "FASHION", "Э": "ЭМОЦИИ", "К": "КАТАЛОГ", "Б": "БЬЮТИ", "Т": "ТЕСТЫ" };
  const state = await env.DB.prepare("SELECT finished FROM instagram_plan_sessions WHERE chat_id=? AND thread_id=? AND day_key=?")
    .bind(k.chat, k.thread, day).first<{ finished: number }>();
  if (state?.finished) { await send(env, m, "План уже завершён. Чтобы начать заново, отправь /clear."); return; }
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM instagram_plan_items WHERE chat_id=? AND thread_id=? AND day_key=?")
    .bind(k.chat, k.thread, day).first<{ count: number }>();
  const count = countRow?.count ?? 0;
  if (count >= 10) { await send(env, m, "В одной серии максимум 10 Stories. Отправь /finish, чтобы завершить план."); return; }
  if (!body && !cat) { await send(env, m, "Отправь текст одного пункта. Категорию можно добавить в конце: (Ф), (Э), (К), (Б) или (Т)."); return; }
  if (count === 0) await env.DB.prepare("DELETE FROM instagram_plans WHERE chat_id=? AND thread_id=? AND day_key=?").bind(k.chat, k.thread, day).run();
  const category: Category = count === 0 ? "FASHION_HELLO" : cat ? categoryMap[cat[1].toUpperCase()] : "ANY";
  await env.DB.prepare("INSERT OR IGNORE INTO instagram_plan_items(chat_id,thread_id,day_key,story_text,category,source_message_id) VALUES(?,?,?,?,?,?)")
    .bind(k.chat, k.thread, day, body, category, m.message_id).run();
  const inserted = await env.DB.prepare("SELECT id FROM instagram_plan_items WHERE chat_id=? AND thread_id=? AND day_key=? AND source_message_id=?")
    .bind(k.chat, k.thread, day, m.message_id).first<{ id: number }>();
  const position = inserted ? await env.DB.prepare("SELECT COUNT(*) AS count FROM instagram_plan_items WHERE chat_id=? AND thread_id=? AND day_key=? AND id<=?")
    .bind(k.chat, k.thread, day, inserted.id).first<{ count: number }>() : null;
  await send(env, m, "✓ Пункт " + (position?.count ?? count + 1) + "/10 сохранён" + (category === "FASHION_HELLO" ? " · приветствие" : category === "ANY" ? " · случайная категория" : " · " + category) + ".\nСледующий пункт можно отправлять отдельным сообщением.");
}
async function finishPlan(env: Env, m: Message): Promise<void> {
  const k = key(m), day = dayKey();
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM instagram_plan_items WHERE chat_id=? AND thread_id=? AND day_key=?")
    .bind(k.chat, k.thread, day).first<{ count: number }>();
  let total = count?.count ?? 0;
  if (!total) {
    const legacy = await env.DB.prepare("SELECT plan_json FROM instagram_plans WHERE chat_id=? AND thread_id=? AND day_key=?")
      .bind(k.chat, k.thread, day).first<{ plan_json: string }>();
    if (legacy) { try { total = (JSON.parse(legacy.plan_json) as unknown[]).length; } catch { total = 0; } }
  }
  if (!total) { await send(env, m, "План пока пуст. Сначала отправь пункты отдельными сообщениями."); return; }
  await env.DB.prepare("INSERT INTO instagram_plan_sessions(chat_id,thread_id,day_key,finished) VALUES(?,?,?,1) ON CONFLICT(chat_id,thread_id,day_key) DO UPDATE SET finished=1")
    .bind(k.chat, k.thread, day).run();
  await send(env, m, "План завершён: " + total + " пункт(ов). Отправь /generate здесь или в теме «Генератор».");
}
async function clearPlan(env: Env, m: Message): Promise<void> {
  const k = key(m), day = dayKey();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM instagram_plan_items WHERE chat_id=? AND thread_id=? AND day_key=?").bind(k.chat,k.thread,day),
    env.DB.prepare("DELETE FROM instagram_plan_sessions WHERE chat_id=? AND thread_id=? AND day_key=?").bind(k.chat,k.thread,day),
    env.DB.prepare("DELETE FROM instagram_plans WHERE chat_id=? AND thread_id=? AND day_key=?").bind(k.chat,k.thread,day),
  ]);
  await send(env, m, "План очищен. Можно собирать новую серию.");
}
async function loadPlan(env: Env, chatId: string, threadId: number, day: string): Promise<Array<{ n: number; text: string; category: Category }>> {
  const rows = await env.DB.prepare("SELECT story_text,category FROM instagram_plan_items WHERE chat_id=? AND thread_id=? AND day_key=? ORDER BY id")
    .bind(chatId, threadId, day).all<{ story_text: string; category: Category }>();
  if (rows.results?.length) return rows.results.map((x, i) => ({ n: i + 1, text: x.story_text, category: x.category }));
  const legacy = await env.DB.prepare("SELECT plan_json FROM instagram_plans WHERE chat_id=? AND thread_id=? AND day_key=?")
    .bind(chatId, threadId, day).first<{ plan_json: string }>();
  if (!legacy) return [];
  try { return JSON.parse(legacy.plan_json) as Array<{ n: number; text: string; category: Category }>; } catch { return []; }
}
async function enqueueGeneration(env: Env, m: Message): Promise<void> {
  const topic = await currentTopic(env, m);
  if (topic !== "plan" && topic !== "generator") { await send(env, m, "Команду /generate отправь в теме «План» или «Генератор»."); return; }
  const chatId = String(m.chat.id), day = dayKey();
  const planTopic = await env.DB.prepare("SELECT thread_id FROM instagram_topics WHERE chat_id=? AND topic_key='plan'")
    .bind(chatId).first<{ thread_id: number }>();
  const generatorTopic = await env.DB.prepare("SELECT thread_id FROM instagram_topics WHERE chat_id=? AND topic_key='generator'")
    .bind(chatId).first<{ thread_id: number }>();
  if (!generatorTopic) { await send(env, m, "Не найдена тема «Генератор». Зарегистрируй её командой /topic generator."); return; }
  const planThreadId = planTopic?.thread_id ?? (topic === "plan" ? (m.message_thread_id ?? 0) : 0);
  if (!planThreadId) { await send(env, m, "Не найдена тема «План». Зарегистрируй её командой /topic plan."); return; }
  const plan = await loadPlan(env, chatId, planThreadId, day);
  if (!plan.length) { await send(env, m, "План пуст. Отправь пункты в теме «План», затем /generate."); return; }
  if (plan.length > 10) { await send(env, m, "В серии может быть не больше 10 Stories."); return; }
  const planJson = JSON.stringify(plan);
  const active = await env.DB.prepare("SELECT job_id FROM instagram_story_jobs WHERE chat_id=? AND status IN ('pending','processing') LIMIT 1")
    .bind(chatId).first<{ job_id: string }>();
  if (active) { await send(env, m, "Сборка уже стоит в очереди или выполняется. Повторно запускать её не нужно."); return; }
  const last = await env.DB.prepare("SELECT plan_json,status FROM instagram_story_jobs WHERE chat_id=? AND day_key=? ORDER BY created_at DESC LIMIT 1")
    .bind(chatId, day).first<{ plan_json: string; status: string }>();
  if (last?.status === "completed" && last.plan_json === planJson) {
    await send(env, m, "Эта версия плана уже собрана сегодня. Результат находится в теме «Генератор»."); return;
  }
  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  try {
    await env.DB.prepare("INSERT INTO instagram_story_jobs(job_id,chat_id,plan_thread_id,output_thread_id,day_key,plan_json,status,progress) VALUES(?,?,?,?,?,?, 'pending','В очереди')")
      .bind(jobId, chatId, planThreadId, generatorTopic.thread_id, day, planJson).run();
  } catch (error) {
    const duplicate = await env.DB.prepare("SELECT job_id FROM instagram_story_jobs WHERE chat_id=? AND status IN ('pending','processing') LIMIT 1")
      .bind(chatId).first<{ job_id: string }>();
    if (duplicate) { await send(env, m, "Сборка уже стоит в очереди или выполняется."); return; }
    throw error;
  }
  await send(env, m, "✓ План принят. Задание #" + jobId + " поставлено в очередь. Статус и результат будут в теме «Генератор».");
  await sendToTopic(env, m.chat.id, generatorTopic.thread_id, "🕓 Новая серия принята в очередь. Задание #" + jobId + ". Начало обработки — в ближайшую минуту.");
}
async function sendToTopic(env: Env, chatId: number, threadId: number, text: string): Promise<void> {
  await api(env, "sendMessage", { chat_id: chatId, message_thread_id: threadId, text });
}
export async function processInstagramStoryJobs(env: Env): Promise<void> {
  // A single invocation renders at most one Story. The next Cron tick resumes this job.
  const stale = await env.DB.prepare("SELECT job_id,chat_id,output_thread_id FROM instagram_story_jobs WHERE status='processing' AND updated_at < datetime('now','-15 minutes') LIMIT 5")
    .all<{ job_id: string; chat_id: string; output_thread_id: number }>();
  for (const item of stale.results ?? []) {
    await env.DB.prepare("UPDATE instagram_story_jobs SET status='failed',last_error='Задача прервана: превышено время обработки. Отправь /generate повторно.',updated_at=CURRENT_TIMESTAMP WHERE job_id=? AND status='processing'")
      .bind(item.job_id).run();
    await sendToTopic(env, Number(item.chat_id), item.output_thread_id, "❌ Задание #" + item.job_id + " прервано по тайм-ауту. Отправь /generate повторно.");
  }

  const job = await env.DB.prepare(
    "SELECT job_id,chat_id,output_thread_id,plan_json,attempts,next_story_index,style,used_photo_ids_json FROM instagram_story_jobs WHERE status='pending' OR (status='processing' AND updated_at < datetime('now','-5 minutes')) ORDER BY CASE WHEN status='processing' THEN 0 ELSE 1 END,created_at LIMIT 1",
  ).first<{
    job_id: string; chat_id: string; output_thread_id: number; plan_json: string; attempts: number;
    next_story_index: number; style: number | null; used_photo_ids_json: string;
  }>();
  if (!job) return;

  const claim = await env.DB.prepare(
    "UPDATE instagram_story_jobs SET status='processing',attempts=attempts+1,progress='Подготовка Story',updated_at=CURRENT_TIMESTAMP WHERE job_id=? AND (status='pending' OR (status='processing' AND updated_at < datetime('now','-5 minutes')))",
  ).bind(job.job_id).run();
  if (!claim.meta.changes) return;

  const chatId = Number(job.chat_id), outputThreadId = job.output_thread_id;
  const plan = JSON.parse(job.plan_json) as Array<{ n: number; text: string; category: Category }>;
  const style = job.style === null ? (Math.random() < 0.5 ? 0 : 1) : job.style;
  const used = new Set<string>(JSON.parse(job.used_photo_ids_json || "[]") as string[]);

  try {
    if (job.next_story_index === 0) {
      await sendToTopic(env, chatId, outputThreadId, "⚙️ Начинаю сборку задания #" + job.job_id + ". Stories: " + plan.length + ". Буду готовить по одной фотографии.");
      await env.DB.prepare("UPDATE instagram_story_jobs SET style=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=? AND status='processing'")
        .bind(style, job.job_id).run();
    }

    if (job.next_story_index < plan.length) {
      const index = job.next_story_index;      const item = plan[index];
      if (index > 0 && !item.text?.trim()) {
        throw new Error("В плане для Story " + item.n + " нет текста. Добавь текстовый пункт и запусти новую серию.");
      }
      const rows = item.category === "ANY"
        ? await env.DB.prepare("SELECT telegram_file_id,file_unique_id FROM instagram_photos WHERE chat_id=? ORDER BY RANDOM()")            .bind(job.chat_id).all<{ telegram_file_id: string; file_unique_id: string }>()
        : await env.DB.prepare("SELECT telegram_file_id,file_unique_id FROM instagram_photos WHERE chat_id=? AND category=? ORDER BY RANDOM()")
            .bind(job.chat_id, item.category).all<{ telegram_file_id: string; file_unique_id: string }>();
      const available = (rows.results ?? []).filter(x => !used.has(x.file_unique_id));
      if (!available.length) throw new Error("Не хватает фотографий для пункта " + item.n + ". Проверь библиотеку нужной категории.");
      const chosen = available[0];
      used.add(chosen.file_unique_id);

      const photo = await downloadPhoto(env, chosen.telegram_file_id);
      const png = await render(photo, item.n === 1 ? "" : item.text, style);
      const outputMessage: Message = { message_id: 0, message_thread_id: outputThreadId, chat: { id: chatId, type: "supergroup" } };
      // Publish each Story immediately; no intermediate object storage is needed.
      await publish(env, outputMessage, [png]);

      const nextIndex = index + 1;
      const completed = nextIndex >= plan.length;
      await env.DB.prepare(
        "UPDATE instagram_story_jobs SET next_story_index=?,used_photo_ids_json=?,style=?,status=?,progress=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=? AND status='processing'",
      ).bind(nextIndex, JSON.stringify([...used]), style, completed ? "completed" : "processing",
        completed ? "Готово" : "Отправлено " + nextIndex + " из " + plan.length, job.job_id).run();
      await sendToTopic(env, chatId, outputThreadId,
        "🖼 Story " + nextIndex + " из " + plan.length + " отправлена." +
        (completed ? "\n✅ Все Stories готовы. Каждая отправлена отдельным сообщением." : ""));
      return;
    }

    // Recovery path: all Stories were already sent before a previous invocation ended.
    await env.DB.prepare("UPDATE instagram_story_jobs SET status='completed',progress='Готово',updated_at=CURRENT_TIMESTAMP WHERE job_id=? AND status='processing'")
      .bind(job.job_id).run();
    await sendToTopic(env, chatId, outputThreadId, "✅ Все Stories уже отправлены.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE instagram_story_jobs SET status='failed',last_error=?,progress='Ошибка',updated_at=CURRENT_TIMESTAMP WHERE job_id=? AND status='processing'")
      .bind(reason.slice(0, 1500), job.job_id).run();
    console.error("Instagram Stories queued job failed", { jobId: job.job_id, storyIndex: job.next_story_index, reason });
    await sendToTopic(env, chatId, outputThreadId, "❌ Не удалось собрать Stories (этап " + (job.next_story_index + 1) + " из " + plan.length + "). Причина: " + reason.slice(0, 500));
  }
}

async function generate(env: Env, m: Message): Promise<void> {
  const k = key(m), day = dayKey();
  const planRow = await env.DB.prepare("SELECT plan_json FROM instagram_plans WHERE chat_id=? AND day_key=? ORDER BY updated_at DESC LIMIT 1").bind(k.chat, day).first<{ plan_json: string }>();
  if (!planRow) { await send(env, m, "Сначала отправь сценарий в теме «План»."); return; }
  const plan = JSON.parse(planRow.plan_json) as Array<{ n: number; text: string; category: Category }>;
  const style = Math.random() < 0.5 ? 0 : 1;
  const output: Uint8Array[] = [];
  const used = new Set<string>();
  for (const item of plan) {
    const rows = item.category === "ANY"
      ? await env.DB.prepare("SELECT telegram_file_id,file_unique_id FROM instagram_photos WHERE chat_id=? ORDER BY RANDOM()")
          .bind(k.chat).all<{ telegram_file_id: string; file_unique_id: string }>()
      : await env.DB.prepare("SELECT telegram_file_id,file_unique_id FROM instagram_photos WHERE chat_id=? AND category=? ORDER BY RANDOM()")
          .bind(k.chat, item.category).all<{ telegram_file_id: string; file_unique_id: string }>();
    const available = (rows.results ?? []).filter(x => !used.has(x.file_unique_id));
    if (!available.length) { await send(env, m, "Не хватает фотографий для пункта " + item.n + ". Проверь, что в библиотеке есть фотографии нужной категории."); return; }
    const chosen = available[0]; used.add(chosen.file_unique_id);
    const photo = await downloadPhoto(env, chosen.telegram_file_id);
    output.push(await render(photo, item.n === 1 ? "" : item.text, style));
  }
  if (!output.length) { await send(env, m, "Сценарий пуст."); return; }
  await publish(env, m, output);
  await send(env, m, "Готово! Stories собраны. Вся серия оформлена в одном стиле.");
}
async function currentTopic(env: Env, m: Message): Promise<string | null> {
  if (!m.message_thread_id) return null;
  const row = await env.DB.prepare("SELECT topic_key FROM instagram_topics WHERE chat_id=? AND thread_id=?")
    .bind(String(m.chat.id), m.message_thread_id).first<{ topic_key: string }>();
  return row?.topic_key ?? null;
}
async function registerTopic(env: Env, m: Message, topic: string): Promise<void> {
  if (!m.message_thread_id) { await send(env, m, "Команду нужно отправить внутри нужной темы группы."); return; }
  await env.DB.prepare("INSERT INTO instagram_topics(chat_id,topic_key,thread_id) VALUES(?,?,?) ON CONFLICT(chat_id,topic_key) DO UPDATE SET thread_id=excluded.thread_id")
    .bind(String(m.chat.id), topic, m.message_thread_id).run();
  await send(env, m, "Тема зарегистрирована: " + topic);
}
export async function handleInstagramUpdate(env: Env, update: Update): Promise<void> {
  if (update.callback_query?.data?.startsWith("story:")) { await handleStoryStyleCallback(env, update.callback_query); return; }
  const m = update.message; if (!m) return;
  if (m.chat.type !== "group" && m.chat.type !== "supergroup") return;
  const text = (m.text ?? "").trim();
  const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/);
  if (command?.[1] === "igstatus") {
    if (!m.from || !env.OWNER_TELEGRAM_ID || String(m.from.id) !== String(env.OWNER_TELEGRAM_ID)) return;
    try {
      const info = await api(env, "getWebhookInfo", {});
      const me = await api(env, "getMe", {});
      await send(env, m,
        "Instagram bot webhook diagnostic\\n" +
        "Bot: @" + (me.username ?? "unknown") + " (id " + me.id + ")\\n" +
        "URL: " + (info.url || "NOT SET") + "\\n" +
        "Allowed updates: " + JSON.stringify(info.allowed_updates ?? "default") + "\\n" +
        "Pending updates: " + (info.pending_update_count ?? "unknown") + "\\n" +
        "Last error: " + (info.last_error_message ?? "none") + "\\n" +
        "Last error date: " + (info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : "none")
      );
    } catch (error) {
      await send(env, m, "Не удалось получить статус webhook: " + (error instanceof Error ? error.message : String(error)));
    }
    return;
  }
  if (command?.[1] === "start" || command?.[1] === "help") {
    await send(env, m, "Instagram Stories бот готов.\n\nРегистрация тем: /topic greeting, /topic album, /topic plan, /topic generator — по одной команде в каждой теме.\n\nВ «Fashion привет» просто загружай фото без подписи — бот автоматически сохранит их как FASHION_HELLO. В «Альбом» указывай в подписи первого фото категорию: Ф, Э, К, Б или Т.\nВ «План» отправляй каждый пункт отдельным сообщением. В конце /finish (необязательно), затем /generate можно отправить здесь или в «Генератор». Категории: (Ф) — фэшн, (Э) — эмоции, (К) — каталог, (Б) — бьюти, (Т) — тесты. Без буквы — случайное фото. Все статусы и готовые Stories приходят в «Генератор».");
    return;
  }
  if (command?.[1] === "topic" && command[2]) {
    const topic = command[2].toLowerCase();
    if ((topicNames as readonly string[]).includes(topic)) await registerTopic(env, m, topic);
    else await send(env, m, "Допустимые темы: greeting, album, plan, generator.");
    return;
  }
  if (command?.[1] === "generate") { await enqueueGeneration(env, m); return; }
  if (command?.[1] === "finish") {
    if (await currentTopic(env, m) !== "plan") { await send(env, m, "/finish отправь в теме «План»."); return; }
    await finishPlan(env, m); return;
  }
  if (command?.[1] === "clear") {
    if (await currentTopic(env, m) !== "plan") { await send(env, m, "/clear отправь в теме «План»."); return; }
    await clearPlan(env, m); return;
  }
  if (m.photo?.length) {
    const topic = await currentTopic(env, m);
    if (topic === "generator") {
      const storyText = (m.caption ?? "").trim();
      if (!storyText) {
        await send(env, m, "Добавь подпись к фотографии прямо при отправке. Я размещу её на изображении и верну готовую Story.");
        return;
      }
      try {
        const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        // Persist the pending choice before exposing clickable buttons to Telegram.
        await env.DB.prepare("INSERT INTO instagram_story_style_pending(id,chat_id,thread_id,user_id,photo_file_id,story_text,stage,prompt_message_id) VALUES(?,?,?,?,?,?, 'position',NULL)")
          .bind(id, String(m.chat.id), m.message_thread_id ?? 0, String(m.from?.id ?? 0), m.photo[m.photo.length - 1].file_id, storyText).run();
        const prompt = await api(env, "sendMessage", {
          chat_id: m.chat.id,
          ...(m.message_thread_id ? { message_thread_id: m.message_thread_id } : {}),
          text: "Шаг 1/3. Выбери один из пяти участков фотографии:",
          reply_markup: storyKeyboard(id, "position"),
        });
        await env.DB.prepare("UPDATE instagram_story_style_pending SET prompt_message_id=? WHERE id=?")
          .bind(prompt.message_id ?? null, id).run();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error("Direct Instagram Story setup failed", { messageId: m.message_id, reason });
        await send(env, m, "❌ Не удалось подготовить выбор оформления: " + reason.slice(0, 400));
      }
      return;
    }
    if (topic !== "album" && topic !== "greeting") { await send(env, m, "Фотографии с подписью для готовой Story отправляй в тему «Генератор». Для библиотеки фото используй темы «Альбом» и «Fashion привет»."); return; }
    const caption = (m.caption ?? "").trim().toUpperCase();
    const categoryCodes: Record<string, Category> = { "Ф": "FASHION", "Э": "ЭМОЦИИ", "К": "КАТАЛОГ", "Б": "БЬЮТИ", "Т": "ТЕСТЫ" };
    let category: Category | null = topic === "greeting" ? "FASHION_HELLO" : ((categories as string[]).includes(caption) ? caption as Category : categoryCodes[caption] ?? (caption === "FASHION_HELLO" ? "FASHION_HELLO" : null));
    if (!category && !m.caption && m.from) {
      const context = await env.DB.prepare("SELECT category FROM instagram_upload_context WHERE chat_id=? AND thread_id=? AND uploader_id=? AND day_key=? AND media_group_id=?")
        .bind(String(m.chat.id), m.message_thread_id ?? 0, String(m.from.id), dayKey(), m.media_group_id ?? null).first<{ category: Category }>();
      category = context?.category ?? null;
    }
    if (category === "FASHION_HELLO" && topic !== "greeting") { await send(env, m, "Категорию FASHION_HELLO загружай в тему «Fashion привет»."); return; }
    if (category && category !== "FASHION_HELLO" && topic !== "album") { await send(env, m, "Категории Ф, Э, К, Б и Т загружай в тему «Альбом»."); return; }
    if (!category) { await send(env, m, "Не удалось определить категорию. В подписи к первому фото укажи Ф, Э, К, Б или Т. Для приветствия — FASHION_HELLO."); return; }
    await savePhoto(env, m, category);
    if (m.caption) await send(env, m, "Фотоальбом принят: категория " + category + ". Остальные фото альбома сохраняются автоматически.");
    return;
  }
  if (m.text && await currentTopic(env, m) === "plan" && !text.startsWith("/")) { await processPlanItem(env, m); return; }
}
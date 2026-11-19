import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import cyrillic from "@fontsource/roboto/files/roboto-cyrillic-400-normal.woff2";
import latin from "@fontsource/roboto/files/roboto-latin-400-normal.woff2";

type Env = { DB: D1Database; INST_BOT_TOKEN: string };
type Photo = { file_id: string; file_unique_id: string; width: number; height: number };
type Message = {
  message_id: number; message_thread_id?: number; media_group_id?: string;
  chat: { id: number; type: string }; from?: { id: number; first_name?: string };
  text?: string; caption?: string; photo?: Photo[];
};
type Update = { message?: Message; };
type Category = "FASHION_HELLO" | "FASHION" | "КАТАЛОГ" | "ТЕСТЫ" | "ЭМОЦИИ" | "БЬЮТИ";
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
function wrap(text: string): string[] {
  const words = text.trim().split(/\s+/); const lines: string[] = []; let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > 26 && line) { lines.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}
async function render(photo: Uint8Array, text: string, style: number): Promise<Uint8Array> {
  wasmReady ??= initWasm(wasm); await wasmReady;
  const fonts = "@font-face{font-family:R;src:url(data:font/woff2;base64," + b64(new Uint8Array(cyrillic)) + ")}@font-face{font-family:R;src:url(data:font/woff2;base64," + b64(new Uint8Array(latin)) + ")}";
  const lines = text ? wrap(text) : [];
  const size = style === 0 ? 58 : 52, lineHeight = Math.round(size * 1.2), height = lines.length * lineHeight + 84, y = 1920 - height - 150;
  const tspans = lines.map((line, i) => '<tspan x="76" dy="' + (i ? lineHeight : 0) + '">' + esc(line) + "</tspan>").join("");
  const color = style === 0 ? "#fff" : "#171717", panel = style === 0 ? "rgba(0,0,0,.42)" : "rgba(255,255,255,.88)";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1920"><style>' + fonts + '</style><image width="1080" height="1920" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/jpeg;base64,' + b64(photo) + '"/>' +
    (text ? '<rect x="42" y="' + (y - 40) + '" width="996" height="' + height + '" rx="' + (style === 0 ? 24 : 0) + '" fill="' + panel + '"/><text x="76" y="' + (y + 18) + '" fill="' + color + '" font-family="R,Arial" font-size="' + size + '" font-weight="700">' + tspans + "</text>" : "") + "</svg>";
  return new Resvg(svg, { fitTo: { mode: "width", value: 1080 } }).render().asPng();
}
async function publish(env: Env, m: Message, images: Uint8Array[]): Promise<void> {
  const form = new FormData();
  form.set("chat_id", String(m.chat.id));
  if (m.message_thread_id) form.set("message_thread_id", String(m.message_thread_id));
  form.set("media", JSON.stringify(images.map((_, i) => ({ type: "photo", media: "attach://story" + i + ".png" }))));
  images.forEach((v, i) => form.set("story" + i + ".png", new Blob([v], { type: "image/png" }), "story" + i + ".png"));
  const r = await fetch("https://api.telegram.org/bot" + env.INST_BOT_TOKEN + "/sendMediaGroup", { method: "POST", body: form });
  const j: any = await r.json(); if (!r.ok || !j.ok) throw new Error(j.description || "Не удалось отправить Stories.");
}
async function savePhoto(env: Env, m: Message, category: Category): Promise<void> {
  const p = m.photo?.[m.photo.length - 1]; if (!p) return;
  const k = key(m), uploader = String(m.from?.id ?? 0), day = dayKey();
  await env.DB.prepare(
    "INSERT INTO instagram_upload_context(chat_id,thread_id,uploader_id,day_key,category,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(chat_id,thread_id,uploader_id,day_key) DO UPDATE SET category=excluded.category,updated_at=CURRENT_TIMESTAMP",
  ).bind(k.chat, k.thread, uploader, day, category).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO instagram_photos(chat_id,thread_id,category,telegram_file_id,file_unique_id,uploaded_by,day_key,source_message_id) VALUES(?,?,?,?,?,?,?,?)",
  ).bind(k.chat, k.thread, category, p.file_id, p.file_unique_id, uploader, day, m.message_id).run();
}
async function processPlan(env: Env, m: Message): Promise<void> {
  const k = key(m), text = (m.text ?? "").trim();
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const items: Array<{ n: number; text: string; category: Category }> = [];
  for (const line of lines) {
    const match = line.match(/^(\d+)[.)]\s*(.+)$/); if (!match) continue;
    const n = Number(match[1]), body = match[2].trim();
    const cat = body.match(/\((FASHION|КАТАЛОГ|ТЕСТЫ|ЭМОЦИИ|БЬЮТИ)\)\s*$/i);
    const clean = body.replace(/\s*\((FASHION|КАТАЛОГ|ТЕСТЫ|ЭМОЦИИ|БЬЮТИ)\)\s*$/i, "").trim();
    items.push({ n, text: clean, category: n === 1 ? "FASHION_HELLO" : (cat?.[1].toUpperCase() as Category) || "FASHION" });
  }
  if (!items.length || items[0].n !== 1) { await send(env, m, "Не вижу сценарий. Отправь пункты в формате:\n1. Фэшн привет!\n2. Текст сторис (БЬЮТИ)\n3. Следующий текст (ЭМОЦИИ)"); return; }
  await env.DB.prepare("INSERT INTO instagram_plans(chat_id,thread_id,day_key,plan_json,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(chat_id,thread_id,day_key) DO UPDATE SET plan_json=excluded.plan_json,updated_at=CURRENT_TIMESTAMP")
    .bind(k.chat, k.thread, dayKey(), JSON.stringify(items)).run();
  await send(env, m, "Сценарий сохранён: " + items.length + " сторис. Для генерации отправь /generate в теме «Генератор».");
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
    const rows = await env.DB.prepare("SELECT telegram_file_id,file_unique_id FROM instagram_photos WHERE chat_id=? AND day_key=? AND category=? ORDER BY RANDOM() LIMIT 30")
      .bind(k.chat, day, item.category).all<{ telegram_file_id: string; file_unique_id: string }>();
    const available = (rows.results ?? []).filter(x => !used.has(x.file_unique_id));
    if (!available.length) { await send(env, m, "Не хватает фотографий категории " + item.category + " для пункта " + item.n + ". Загрузи фото в теме «Альбом» с подписью-категорией."); return; }
    const chosen = available[0]; used.add(chosen.file_unique_id);
    const photo = await downloadPhoto(env, chosen.telegram_file_id);
    output.push(await render(photo, item.n === 1 ? "" : item.text, style));
  }
  if (!output.length) { await send(env, m, "Сценарий пуст."); return; }
  await publish(env, m, output);
  await send(env, m, "Готово! Stories собраны. Вся серия оформлена в одном стиле.");
}
async function registerTopic(env: Env, m: Message, topic: string): Promise<void> {
  if (!m.message_thread_id) { await send(env, m, "Команду нужно отправить внутри нужной темы группы."); return; }
  await env.DB.prepare("INSERT INTO instagram_topics(chat_id,topic_key,thread_id) VALUES(?,?,?) ON CONFLICT(chat_id,topic_key) DO UPDATE SET thread_id=excluded.thread_id")
    .bind(String(m.chat.id), topic, m.message_thread_id).run();
  await send(env, m, "Тема зарегистрирована: " + topic);
}
export async function handleInstagramUpdate(env: Env, update: Update): Promise<void> {
  const m = update.message; if (!m) return;
  if (m.chat.type !== "group" && m.chat.type !== "supergroup") return;
  const text = (m.text ?? "").trim();
  const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/);
  if (command?.[1] === "start" || command?.[1] === "help") {
    await send(env, m, "Instagram Stories бот готов.\n\nРегистрация тем: /topic greeting, /topic album, /topic plan, /topic generator — по одной команде в каждой теме.\n\nВ «Альбом» загружай фотоальбом с подписью первой фотографии: FASHION, КАТАЛОГ, ТЕСТЫ, ЭМОЦИИ или БЬЮТИ. Для приветствия используй FASHION_HELLO.\nВ «План» отправь сценарий, в «Генератор» — /generate.");
    return;
  }
  if (command?.[1] === "topic" && command[2]) {
    const topic = command[2].toLowerCase();
    if ((topicNames as readonly string[]).includes(topic)) await registerTopic(env, m, topic);
    else await send(env, m, "Допустимые темы: greeting, album, plan, generator.");
    return;
  }
  if (command?.[1] === "generate") { await generate(env, m); return; }
  if (m.photo?.length) {
    const caption = (m.caption ?? "").trim().toUpperCase();
    let category: Category | null = (categories as string[]).includes(caption) ? caption as Category : caption === "FASHION_HELLO" ? "FASHION_HELLO" : null;
    if (!category && !m.caption && m.from) {
      const context = await env.DB.prepare("SELECT category FROM instagram_upload_context WHERE chat_id=? AND thread_id=? AND uploader_id=? AND day_key=?")
        .bind(String(m.chat.id), m.message_thread_id ?? 0, String(m.from.id), dayKey()).first<{ category: Category }>();
      category = context?.category ?? null;
    }
    if (!category) { await send(env, m, "Не удалось определить категорию. В подписи к первому фото альбома укажи FASHION, КАТАЛОГ, ТЕСТЫ, ЭМОЦИИ, БЬЮТИ или FASHION_HELLO."); return; }
    await savePhoto(env, m, category);
    if (m.caption) await send(env, m, "Фотоальбом принят: категория " + category + ". Остальные фото альбома сохраняются автоматически.");
    return;
  }
  if (m.text && /^\s*1[.)]/m.test(text)) { await processPlan(env, m); return; }
}

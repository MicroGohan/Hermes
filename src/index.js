"use strict";
// Hermes — puente WhatsApp -> Claude Code
// Recibe texto o notas de voz por WhatsApp (solo de tu número autorizado),
// transcribe el audio con Whisper y ejecuta el mensaje en Claude Code.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
} = require("baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const path = require("node:path");
const fs = require("node:fs");

const {
  runClaude,
  resetTopic,
  activeTopic,
  listTopics,
  switchTopic,
  deleteTopic,
  compactActive,
} = require("./claude-runner");

const ALLOWED = String(process.env.ALLOWED_NUMBER || "").replace(/\D/g, "");
const STT_URL = process.env.STT_URL || "http://127.0.0.1:8000";
const AUTH_DIR = path.join(__dirname, "..", "auth");
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, "..", "media", "incoming");
const logger = pino({ level: "silent" });

// --- Manejo de archivos / imágenes -----------------------------------------

// mimetype -> extensión (para nombrar lo que llega sin nombre, p.ej. fotos).
const MIME_TO_EXT = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/gif": ".gif", "application/pdf": ".pdf",
};
// extensión -> mimetype (para enviar documentos con el tipo correcto).
const EXT_TO_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".csv": "text/csv", ".zip": "application/zip", ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

// Detecta media entrante soportada (imagen, documento o video) ya desenvuelta.
function getIncomingMedia(content) {
  if (!content) return null;
  if (content.imageMessage) return { kind: "image", node: content.imageMessage };
  if (content.documentMessage) return { kind: "document", node: content.documentMessage };
  if (content.videoMessage) return { kind: "video", node: content.videoMessage };
  return null;
}

// Guarda el buffer entrante en disco y devuelve la ruta absoluta.
function saveIncoming(buffer, media) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  let name = media.node.fileName;
  if (name) {
    name = `${Date.now()}-${name.replace(/[/\\]/g, "_")}`; // evita colisiones / rutas
  } else {
    const ext = MIME_TO_EXT[media.node.mimetype] || (media.kind === "image" ? ".jpg" : "");
    name = `${media.kind}-${Date.now()}${ext}`;
  }
  const filePath = path.join(MEDIA_DIR, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// Envía un archivo por WhatsApp: imagen si lo es por extensión, si no documento.
async function sendFile(sock, jid, filePath) {
  if (!fs.existsSync(filePath)) {
    await sock.sendMessage(jid, { text: `⚠️ No encontré el archivo a enviar: ${filePath}` });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    await sock.sendMessage(jid, { image: { url: filePath } });
  } else {
    await sock.sendMessage(jid, {
      document: { url: filePath },
      fileName: path.basename(filePath),
      mimetype: EXT_TO_MIME[ext] || "application/octet-stream",
    });
  }
}

// Extrae las rutas marcadas con [[ARCHIVO: ...]] y las quita del texto.
function extractOutgoingFiles(reply) {
  const files = [];
  const text = String(reply || "")
    .replace(/\[\[ARCHIVO:\s*([^\]]+?)\]\]/g, (_, p) => {
      files.push(p.trim());
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, files };
}

// --- Comandos y menú de temas ----------------------------------------------

// Orden de temas mostrado en el último /temas, para resolver la selección por número.
let pendingMenu = null;

const HELP =
  "📋 *Comandos de Hermes*\n" +
  "/temas — ver y elegir tema (responde con el número)\n" +
  "/tema <nombre> — crear o cambiar de tema (ej: /tema fit)\n" +
  "/reset — vaciar el contexto del tema actual\n" +
  "/compact — resumir el tema actual para ahorrar tokens\n" +
  "/borrar <nombre> — eliminar un tema\n" +
  "/ayuda — esta ayuda";

function buildMenu() {
  const topics = listTopics();
  pendingMenu = topics.map((t) => t.name);
  const lines = topics.map(
    (t, i) => `${i + 1}. ${t.active ? "👉" : "  "} *${t.name}*${t.started ? "" : " _(vacío)_"}`
  );
  return (
    `🗂️ *Tus temas* (activo 👉):\n\n${lines.join("\n")}\n\n` +
    "Responde con el *número* para cambiar, o:\n" +
    "• /tema <nombre> — crear/cambiar\n" +
    "• /compact — resumir el actual\n" +
    "• /reset — vaciar el actual"
  );
}

// Devuelve true si el texto era un comando (ya atendido); false si es prompt normal.
async function handleCommand(sock, jid, text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd.toLowerCase()) {
    case "/ayuda":
    case "/help":
      await sock.sendMessage(jid, { text: HELP });
      return true;
    case "/temas":
    case "/menu":
      await sock.sendMessage(jid, { text: buildMenu() });
      return true;
    case "/tema": {
      if (!arg) {
        await sock.sendMessage(jid, { text: buildMenu() });
        return true;
      }
      const r = switchTopic(arg);
      await sock.sendMessage(jid, {
        text: r.ok ? `✅ Tema activo: *${r.name}*${r.isNew ? " _(nuevo)_" : ""}` : r.msg,
      });
      return true;
    }
    case "/reset":
      resetTopic();
      await sock.sendMessage(jid, { text: `🧹 Contexto del tema *${activeTopic()}* reiniciado.` });
      return true;
    case "/compact":
    case "/compactar":
      await sock.sendMessage(jid, { text: "🗜️ Compactando el tema actual… (puede tardar un poco)" });
      try {
        const r = await compactActive();
        await sock.sendMessage(jid, {
          text: r.ok
            ? `✅ Tema *${activeTopic()}* compactado. El resumen quedó como nuevo punto de partida.`
            : r.msg,
        });
      } catch (e) {
        await sock.sendMessage(jid, { text: "⚠️ No pude compactar: " + (e.message || String(e)) });
      }
      return true;
    case "/borrar":
    case "/eliminar": {
      if (!arg) {
        await sock.sendMessage(jid, { text: "Dime qué tema borrar, ej: /borrar random" });
        return true;
      }
      const r = deleteTopic(arg);
      await sock.sendMessage(jid, { text: r.ok ? `🗑️ Tema *${r.name}* eliminado.` : r.msg });
      return true;
    }
    default:
      return false; // no es un comando conocido -> se procesa como mensaje normal
  }
}

// Compara dos números por sus últimos 10 dígitos (evita líos con prefijos 52 / 521).
function sameNumber(a, b) {
  const da = String(a).replace(/\D/g, "").slice(-10);
  const db = String(b).replace(/\D/g, "").slice(-10);
  return da.length === 10 && da === db;
}

// Extrae solo el "usuario" de un JID: quita @dominio y el sufijo de dispositivo (:0).
function userPart(jid) {
  return String(jid).split("@")[0].split(":")[0];
}

// WhatsApp puede entregar al remitente como LID (@lid) en vez de su número.
// Resolvemos el LID a número real para poder compararlo con ALLOWED_NUMBER.
async function resolveSenderNumber(sock, msg, jid) {
  if (jid.endsWith("@lid")) {
    // 1) Baileys suele adjuntar el número real en remoteJidAlt.
    if (msg.key.remoteJidAlt) return userPart(msg.key.remoteJidAlt);
    // 2) Si no, lo buscamos en el mapa LID -> número que mantiene Baileys.
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) return userPart(pn);
    } catch { /* si falla, caemos al valor por defecto */ }
  }
  return userPart(jid);
}

async function transcribe(buffer) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "audio/ogg" }), "nota.ogg");
  const res = await fetch(`${STT_URL}/transcribe`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`STT respondió ${res.status}`);
  const json = await res.json();
  console.log(`[stt] ${json.audio_seconds}s audio -> ${json.elapsed}s`);
  return json.text;
}

async function sendLong(sock, jid, text) {
  const LIMIT = 4000;
  if (!text) text = "(sin respuesta)";
  if (text.length <= LIMIT) {
    await sock.sendMessage(jid, { text });
    return;
  }
  for (let i = 0; i < text.length; i += LIMIT) {
    await sock.sendMessage(jid, { text: text.slice(i, i + LIMIT) });
  }
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid || "";
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast")) return; // ignora grupos/estados

  const sender = await resolveSenderNumber(sock, msg, jid);
  if (ALLOWED && !sameNumber(sender, ALLOWED)) {
    console.log("⛔ Ignorado (no autorizado):", sender, jid.endsWith("@lid") ? `(LID ${jid.split("@")[0]})` : "");
    return;
  }

  const m = msg.message;
  const content = extractMessageContent(m) || m; // desenvuelve efímeros / view-once / doc+caption
  let text = content.conversation || content.extendedTextMessage?.text || "";
  const audio = content.audioMessage;
  const media = getIncomingMedia(content);

  // Nota de voz -> transcripción local con Whisper.
  if (!text && audio) {
    await sock.sendPresenceUpdate("composing", jid);
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    try {
      text = await transcribe(buffer);
    } catch (e) {
      await sock.sendMessage(jid, { text: "⚠️ No pude transcribir el audio: " + e.message });
      return;
    }
    await sock.sendMessage(jid, { text: `📝 _Entendí:_ ${text || "(vacío)"}` });
  }

  // Imagen / documento / video -> se guarda en disco y se le pasa la ruta a Claude.
  let mediaNote = "";
  if (media) {
    await sock.sendPresenceUpdate("composing", jid);
    let savedPath;
    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      );
      savedPath = saveIncoming(buffer, media);
    } catch (e) {
      await sock.sendMessage(jid, { text: "⚠️ No pude descargar el archivo: " + e.message });
      return;
    }
    const caption = (media.node.caption || "").trim();
    if (caption) text = caption; // el pie de foto/archivo se usa como instrucción
    const label =
      media.kind === "image" ? "una imagen" : media.kind === "video" ? "un video" : "un archivo";
    mediaNote = `[El usuario adjuntó ${label}, guardada en disco en: ${savedPath}]`;
    await sock.sendMessage(jid, { text: `📎 _Recibí:_ ${path.basename(savedPath)}` });
  }

  text = (text || "").trim();

  // Si mandó solo un archivo sin instrucción, ponemos una por defecto.
  if (!text && media) {
    text = media.kind === "image" ? "Analiza y describe esta imagen." : "Analiza este archivo.";
  }

  if (!text && !media) {
    await sock.sendMessage(jid, { text: "No recibí texto, audio ni archivo que pueda procesar 🤔" });
    return;
  }

  // Comandos y selección de tema (solo en mensajes de texto, no en media adjunta).
  if (!media) {
    // Selección por número justo después de mostrar /temas.
    if (pendingMenu && /^\d+$/.test(text)) {
      const chosen = pendingMenu[parseInt(text, 10) - 1];
      pendingMenu = null;
      if (chosen) {
        switchTopic(chosen);
        await sock.sendMessage(jid, { text: `✅ Tema activo: *${chosen}*` });
      } else {
        await sock.sendMessage(jid, { text: "Número fuera de rango. Escribe /temas para ver la lista." });
      }
      return;
    }
    pendingMenu = null; // cualquier otro mensaje cancela la selección pendiente

    if (text.startsWith("/") && (await handleCommand(sock, jid, text))) return;
  }

  await sock.sendPresenceUpdate("composing", jid);
  await sock.sendMessage(jid, { text: "🤖 Procesando…" });

  const prompt = mediaNote ? `${mediaNote}\n\n${text}` : text;

  const t0 = Date.now();
  let reply;
  try {
    reply = await runClaude(prompt);
  } catch (e) {
    reply = "⚠️ Error ejecutando Claude:\n" + (e.message || String(e));
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // Enviar de vuelta los archivos que Claude haya marcado con [[ARCHIVO: ...]].
  const { text: cleanReply, files } = extractOutgoingFiles(reply);
  for (const f of files) {
    try {
      await sendFile(sock, jid, f);
    } catch (e) {
      await sock.sendMessage(jid, { text: `⚠️ No pude enviar ${f}: ${e.message}` });
    }
  }

  const footer = `_⏱ ${secs}s · 🗂️ ${activeTopic()}_`;
  if (cleanReply) {
    await sendLong(sock, jid, `${cleanReply}\n\n${footer}`);
  } else if (files.length) {
    await sock.sendMessage(jid, { text: footer }); // solo se enviaron archivos
  } else {
    await sendLong(sock, jid, `(sin respuesta)\n\n${footer}`);
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, logger });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\n📲 Escanea este QR desde WhatsApp del número-bot");
      console.log("   (Ajustes › Dispositivos vinculados › Vincular dispositivo):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`🔌 Conexión cerrada (code=${code}).`, loggedOut ? "Sesión cerrada." : "Reconectando…");
      if (!loggedOut) start();
    } else if (connection === "open") {
      console.log("✅ Conectado a WhatsApp. Autorizado:", ALLOWED || "⚠️ CUALQUIERA (define ALLOWED_NUMBER)");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (e) {
        console.error("Error manejando mensaje:", e);
      }
    }
  });
}

start();

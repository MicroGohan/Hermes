"use strict";
// Hermes — puente WhatsApp -> Claude Code
// Recibe texto o notas de voz por WhatsApp (solo de tu número autorizado),
// transcribe el audio con Whisper y ejecuta el mensaje en Claude Code.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const path = require("node:path");

const { runClaude, resetSession } = require("./claude-runner");

const ALLOWED = String(process.env.ALLOWED_NUMBER || "").replace(/\D/g, "");
const STT_URL = process.env.STT_URL || "http://127.0.0.1:8000";
const AUTH_DIR = path.join(__dirname, "..", "auth");
const logger = pino({ level: "silent" });

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
  let text = m.conversation || m.extendedTextMessage?.text || "";
  const audio = m.audioMessage;

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

  text = (text || "").trim();
  if (!text) {
    await sock.sendMessage(jid, { text: "No recibí texto ni audio que pueda procesar 🤔" });
    return;
  }

  if (text.toLowerCase() === "/reset") {
    resetSession();
    await sock.sendMessage(jid, { text: "🧹 Conversación reiniciada." });
    return;
  }

  await sock.sendPresenceUpdate("composing", jid);
  await sock.sendMessage(jid, { text: "🤖 Procesando…" });

  const t0 = Date.now();
  let reply;
  try {
    reply = await runClaude(text);
  } catch (e) {
    reply = "⚠️ Error ejecutando Claude:\n" + (e.message || String(e));
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  await sendLong(sock, jid, `${reply}\n\n_⏱ ${secs}s_`);
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

"use strict";
// Ejecuta Claude Code en modo headless (claude -p) y devuelve el texto del resultado.
// Maneja varios "temas" (sesiones con nombre): cada tema tiene su propio session_id,
// persistido en disco para que sobreviva reinicios del bot.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const WORK_DIR = process.env.WORK_DIR || process.env.HOME;
const DANGEROUS = String(process.env.DANGEROUS_MODE || "true").toLowerCase() === "true";
const PERMISSION_MODE = process.env.PERMISSION_MODE || "default";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const STATE_FILE =
  process.env.SESSIONS_FILE || path.join(__dirname, "..", "state", "sessions.json");

// Le enseñamos a Claude cómo devolver archivos/imágenes por WhatsApp: el puente
// detecta líneas [[ARCHIVO: /ruta]] en la respuesta, las envía y las quita del texto.
const SEND_FILE_HINT =
  "Estás respondiendo a través de un puente de WhatsApp. Si necesitas enviar al " +
  "usuario un archivo o imagen (algo que generaste, un screenshot, un PDF, etc.), " +
  "incluye en tu respuesta una línea con el formato EXACTO [[ARCHIVO: /ruta/absoluta]] " +
  "—una por cada archivo—. Usa rutas absolutas que existan en el disco. El sistema " +
  "enviará esos archivos por WhatsApp y eliminará esas líneas del texto que lee el usuario.";

// --- Estado de temas (persistido en disco) ---------------------------------
const DEFAULT_TOPIC = "general";
let store = { active: DEFAULT_TOPIC, sessions: { [DEFAULT_TOPIC]: null } };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (parsed && parsed.sessions && typeof parsed.sessions === "object") {
      store = parsed;
    }
  } catch {
    /* primera vez o archivo corrupto: usamos el default */
  }
  if (!(store.active in store.sessions)) store.sessions[store.active] = null;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error("⚠️ No pude guardar sessions.json:", e.message);
  }
}

load();

// normaliza el nombre de un tema: minúsculas, sin espacios raros, máx 40 chars.
function normName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", MODEL,
      "--append-system-prompt", SEND_FILE_HINT,
    ];
    const sid = store.sessions[store.active];
    if (sid) args.push("--resume", sid);
    if (DANGEROUS) {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", PERMISSION_MODE);
    }

    const child = spawn("claude", args, { cwd: WORK_DIR, env: process.env });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`claude salió con código ${code}: ${stderr || stdout}`));
      }
      try {
        const json = JSON.parse(stdout);
        if (json.session_id) {
          store.sessions[store.active] = json.session_id;
          save();
        }
        if (json.is_error) {
          return reject(new Error(json.result || json.error || "error desconocido de claude"));
        }
        resolve(json.result ?? json.text ?? stdout.trim());
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

// --- Gestión de temas -------------------------------------------------------
function activeTopic() {
  return store.active;
}

function listTopics() {
  return Object.keys(store.sessions).map((name) => ({
    name,
    active: name === store.active,
    started: !!store.sessions[name], // ya tiene conversación
  }));
}

// Cambia al tema indicado; lo crea si no existe.
function switchTopic(name) {
  const n = normName(name);
  if (!n) return { ok: false, msg: "Dame un nombre de tema, ej: /tema fit" };
  const isNew = !(n in store.sessions);
  if (isNew) store.sessions[n] = null;
  store.active = n;
  save();
  return { ok: true, name: n, isNew };
}

// Vacía el contexto del tema activo (la próxima vez arranca de cero).
function resetTopic() {
  store.sessions[store.active] = null;
  save();
}

function deleteTopic(name) {
  const n = normName(name);
  if (!(n in store.sessions)) return { ok: false, msg: `No existe el tema "${n}".` };
  if (n === DEFAULT_TOPIC) {
    return { ok: false, msg: `No se puede borrar "${DEFAULT_TOPIC}" (es el base). Usa /reset para vaciarlo.` };
  }
  delete store.sessions[n];
  if (store.active === n) store.active = DEFAULT_TOPIC;
  save();
  return { ok: true, name: n };
}

// Compacta el tema activo: pide un resumen del contexto y arranca una sesión
// nueva sembrada con ese resumen, para seguir gastando menos tokens.
async function compactActive() {
  const sid = store.sessions[store.active];
  if (!sid) return { ok: false, msg: "Este tema aún no tiene conversación que compactar." };
  const summary = await runClaude(
    "Resume de forma concisa y estructurada TODO el contexto importante de nuestra " +
    "conversación hasta ahora (hechos, datos, decisiones, estado y preferencias) para " +
    "poder continuar sin perder lo esencial. Devuelve SOLO el resumen, sin preámbulo."
  );
  store.sessions[store.active] = null; // corta la sesión larga
  save();
  await runClaude(
    `Contexto previo (resumen compactado de la conversación anterior de este tema):\n\n${summary}`
  );
  return { ok: true, summary };
}

module.exports = {
  runClaude,
  resetTopic,
  activeTopic,
  listTopics,
  switchTopic,
  deleteTopic,
  compactActive,
};

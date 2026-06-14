"use strict";
// Ejecuta Claude Code en modo headless (claude -p) y devuelve el texto del resultado.
// Mantiene el session_id para dar continuidad a la conversación entre mensajes.

const { spawn } = require("node:child_process");

const WORK_DIR = process.env.WORK_DIR || process.env.HOME;
const DANGEROUS = String(process.env.DANGEROUS_MODE || "true").toLowerCase() === "true";
const PERMISSION_MODE = process.env.PERMISSION_MODE || "default";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

// Le enseñamos a Claude cómo devolver archivos/imágenes por WhatsApp: el puente
// detecta líneas [[ARCHIVO: /ruta]] en la respuesta, las envía y las quita del texto.
const SEND_FILE_HINT =
  "Estás respondiendo a través de un puente de WhatsApp. Si necesitas enviar al " +
  "usuario un archivo o imagen (algo que generaste, un screenshot, un PDF, etc.), " +
  "incluye en tu respuesta una línea con el formato EXACTO [[ARCHIVO: /ruta/absoluta]] " +
  "—una por cada archivo—. Usa rutas absolutas que existan en el disco. El sistema " +
  "enviará esos archivos por WhatsApp y eliminará esas líneas del texto que lee el usuario.";

let sessionId = null;

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", MODEL,
      "--append-system-prompt", SEND_FILE_HINT,
    ];
    if (sessionId) args.push("--resume", sessionId);
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
        if (json.session_id) sessionId = json.session_id;
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

function resetSession() {
  sessionId = null;
}

module.exports = { runClaude, resetSession };

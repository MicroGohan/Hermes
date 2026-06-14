"use strict";
// Ejecuta Claude Code en modo headless (claude -p) y devuelve el texto del resultado.
// Mantiene el session_id para dar continuidad a la conversación entre mensajes.

const { spawn } = require("node:child_process");

const WORK_DIR = process.env.WORK_DIR || process.env.HOME;
const DANGEROUS = String(process.env.DANGEROUS_MODE || "true").toLowerCase() === "true";
const PERMISSION_MODE = process.env.PERMISSION_MODE || "default";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

let sessionId = null;

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json", "--model", MODEL];
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

#!/usr/bin/env bash
# Lanza el servidor de transcripción (Whisper) y luego el puente de WhatsApp.
set -e
cd "$(dirname "$0")"

# carga variables de .env si existe
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

echo "▶ Iniciando servidor de transcripción (Whisper)…"
stt/venv/bin/python stt/stt_server.py &
STT_PID=$!
trap 'echo; echo "Cerrando…"; kill $STT_PID 2>/dev/null' EXIT INT TERM

echo -n "  esperando a que cargue el modelo"
until curl -sf "${STT_URL:-http://127.0.0.1:8000}/health" >/dev/null 2>&1; do
  echo -n "."
  sleep 1
done
echo " ✅"

echo "▶ Iniciando puente de WhatsApp (Baileys)…"
node src/index.js

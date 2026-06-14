# Hermes 🪽

Puente que conecta **WhatsApp → Claude Code**. Le escribes (texto o **nota de voz**)
desde tu teléfono y Claude lo ejecuta en tu PC como si fuera la consola, y te
responde por el mismo chat.

```
WhatsApp ─▶ Baileys (Node) ─▶ Whisper residente (Python) ─▶ claude -p ─▶ respuesta ─▶ WhatsApp
```

- **Texto y audio**: las notas de voz se transcriben localmente con `faster-whisper`
  (modelo `large-v3-turbo`, en CPU, sin enviar tu audio a ningún lado).
- **Imágenes y archivos**: envíale una foto, PDF o documento (con un pie de foto como
  instrucción) y Claude lo analiza. Claude también puede **devolverte** archivos/imágenes.
- **Privado**: solo responde a TU número (whitelist). Ignora grupos y desconocidos.
- **Con memoria**: mantiene la conversación entre mensajes (`/reset` para empezar de cero).

---

## 1. Configuración (una sola vez)

```bash
cp .env.example .env
```

Edita `.env` y pon tu número principal (desde el que escribirás):

```ini
ALLOWED_NUMBER=521XXXXXXXXXX      # tu número, solo dígitos con lada
WORK_DIR=/home/liwson             # dónde ejecutará Claude
DANGEROUS_MODE=true               # ver "Seguridad" abajo
```

> Usas **dos números**: el **bot** (segundo número) es el que se vincula por QR;
> el **tuyo** (principal) es el que pones en `ALLOWED_NUMBER` y desde el que escribes.

## 2. Arrancar

```bash
./start.sh
```

Esto levanta el servidor Whisper (espera ~4 s a que cargue el modelo) y luego el
puente. La **primera vez** aparece un **QR**: escanéalo desde el **número-bot**
en *WhatsApp › Ajustes › Dispositivos vinculados › Vincular dispositivo*.

La sesión queda guardada en `auth/`, así que solo escaneas una vez.

## 3. Usar

Desde tu número, escríbele al número-bot:

- **Texto**: `crea un archivo notas.txt con la lista del super`
- **Nota de voz**: habla normal; te contesta `📝 Entendí: ...` y luego ejecuta.
- **Imagen / archivo**: adjúntalo y escribe el pie de foto como instrucción
  (ej. una foto de un recibo con *"¿cuánto pagué de IVA?"*). Se guarda en `media/`
  y Claude la analiza. Si no pones texto, la describe por defecto.
- **Recibir archivos**: si le pides algo que genere un archivo o imagen, Claude lo
  manda por el chat (internamente marca `[[ARCHIVO: /ruta]]` y el puente lo envía).

### Temas (sesiones con nombre)

Puedes tener varias conversaciones separadas (ej. `fit`, `trabajo`, `random`), cada
una con su propio contexto y memoria. Se guardan en disco (`state/sessions.json`), así
que sobreviven reinicios. El pie de cada respuesta muestra el tema activo (`🗂️`).

| Comando | Qué hace |
|---|---|
| `/temas` | Muestra el menú de temas; responde con el **número** para cambiar |
| `/tema <nombre>` | Crea o cambia de tema (ej. `/tema fit`) |
| `/reset` | Vacía el contexto del tema actual |
| `/compact` | Resume el tema actual y arranca limpio desde ese resumen (ahorra tokens) |
| `/borrar <nombre>` | Elimina un tema |
| `/ayuda` | Lista los comandos |

> Saltar de tema en vez de mezclar todo en una sola charla evita arrastrar contexto
> que no toca → menos tokens y respuestas más enfocadas.

---

## Seguridad ⚠️

`DANGEROUS_MODE=true` hace que Claude **actúe sin pedir permisos** (necesario para
que ejecute tareas solo en modo headless). Las protecciones son:

1. **Whitelist**: solo se procesan mensajes de `ALLOWED_NUMBER`.
2. **WORK_DIR**: define la carpeta de trabajo de Claude.

Cualquiera con acceso a ese chat puede ejecutar comandos en tu PC. Mantén tu
WhatsApp seguro. Si quieres un modo más restrictivo, pon `DANGEROUS_MODE=false`
(pero muchas acciones que requieren permiso fallarán en modo headless).

## Velocidad (medido en este equipo: Ryzen 5 3600, CPU, 6 hilos)

| Largo de nota | Tiempo de transcripción aprox. |
|---|---|
| 5 s  | ~3 s |
| 15 s | ~9 s |
| 30 s | ~17 s |

Para acelerar: sube `STT_THREADS` en `.env` (p.ej. 9 ≈ 75% CPU). A futuro se puede
intentar GPU con `whisper.cpp` + Vulkan en la RX 5500.

## Dejarlo corriendo (arranque automático)

Ya está configurado como **servicio systemd de usuario** con *linger*, así que
arranca solo en cada reinicio (aunque no inicies sesión gráfica):

- Archivo: `~/.config/systemd/user/hermes.service`
- Habilitado al boot: `systemctl --user enable hermes` ✅
- Linger activado: `loginctl enable-linger $USER` ✅

Comandos útiles:

```bash
systemctl --user start hermes      # iniciar ahora
systemctl --user stop hermes       # detener
systemctl --user restart hermes    # reiniciar (p.ej. tras cambiar .env)
systemctl --user status hermes     # ver estado
journalctl --user -u hermes -f     # ver logs en vivo (aquí sale el QR)
systemctl --user disable hermes    # quitar del arranque automático
```

> ⚠️ No ejecutes `./start.sh` a mano **mientras** el servicio está corriendo:
> ambos usarían la misma sesión de WhatsApp (`auth/`) y chocarían. Usa uno u otro.

## Problemas comunes

- **`Ignored build scripts` al instalar**: es normal (pnpm bloquea postinstall por
  seguridad). Hermes funciona igual. Si algo fallara: `pnpm approve-builds`.
- **Se desconecta / pide QR de nuevo**: borra `auth/` y vuelve a escanear.
- **No transcribe**: revisa que el servidor STT esté arriba (`curl http://127.0.0.1:8000/health`).

## Estructura

```
Hermes/
├── start.sh              # lanza todo
├── .env                  # tu config (no se sube a git)
├── src/
│   ├── index.js          # puente Baileys (WhatsApp)
│   └── claude-runner.js  # ejecuta claude -p
└── stt/
    ├── stt_server.py     # servidor Whisper (FastAPI)
    └── venv/             # entorno Python
```

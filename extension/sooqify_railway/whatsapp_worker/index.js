'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const pino = require('pino');
const {
  Browsers,
  DisconnectReason,
  makeWASocket,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const enabled = /^(1|true|yes|on)$/i.test(process.env.WHATSAPP_ENABLED || 'false');
const primaryNumber = String(process.env.WHATSAPP_PRIMARY_NUMBER || '').replace(/\D/g, '').slice(0, 20);
const apiToken = String(process.env.AUDIT_API_TOKEN || '');
const serviceUrlRaw = String(process.env.AUDIT_SERVICE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
const serviceUrl = (serviceUrlRaw.startsWith('https://') ? serviceUrlRaw : `https://${serviceUrlRaw}`)
  .replace(/\/+$/, '');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const authDir = path.join(dataDir, 'whatsapp_auth');
const workerId = `wa_${crypto.randomUUID()}`;
const logger = pino({ level: 'silent' });

if (!enabled) {
  console.log('[whatsapp-worker] disabled by WHATSAPP_ENABLED');
  process.exit(0);
}
if (!primaryNumber || primaryNumber.length < 8) {
  console.error('[whatsapp-worker] WHATSAPP_PRIMARY_NUMBER must include a country code and at least eight digits');
  process.exit(2);
}
if (apiToken.length < 20) {
  console.error('[whatsapp-worker] AUDIT_API_TOKEN is not configured or is too short');
  process.exit(2);
}
let parsedServiceUrl;
try {
  parsedServiceUrl = new URL(serviceUrl);
} catch (_) {
  console.error('[whatsapp-worker] AUDIT_SERVICE_URL is missing or invalid');
  process.exit(2);
}
if (parsedServiceUrl.protocol !== 'https:' || parsedServiceUrl.username || parsedServiceUrl.password || parsedServiceUrl.search || parsedServiceUrl.hash) {
  console.error('[whatsapp-worker] AUDIT_SERVICE_URL must be an HTTPS origin without credentials or query parameters');
  process.exit(2);
}

const primaryJid = `${primaryNumber}@s.whatsapp.net`;
let socket = null;
let stopping = false;
let linked = false;
let halted = false;
let outboxBusy = false;
let reconnectTimer = null;
let statusTimer = null;

function normalizePhone(value) {
  const raw = String(value || '').split('@')[0].split(':')[0];
  return raw.replace(/\D/g, '').slice(0, 20);
}

function messageText(message) {
  const body = message?.message || {};
  return String(
    body.conversation
    || body.extendedTextMessage?.text
    || body.imageMessage?.caption
    || body.documentMessage?.caption
    || body.videoMessage?.caption
    || body.buttonsResponseMessage?.selectedButtonId
    || body.listResponseMessage?.singleSelectReply?.selectedRowId
    || '',
  ).trim();
}

async function apiRequest(route, { method = 'GET', body, raw = false } = {}) {
  const response = await fetch(`${serviceUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: raw ? '*/*' : 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25_000),
    cache: 'no-store',
  });
  if (raw) {
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json()).error || message; } catch (_) {}
      throw new Error(message);
    }
    return response;
  }
  let result = {};
  try { result = await response.json(); } catch (_) {}
  if (!response.ok || result.success === false) {
    throw new Error(String(result.error || `HTTP ${response.status}`));
  }
  return result;
}

async function updateServiceStatus(state, phoneNumber = '', message = '') {
  try {
    await apiRequest('/api/whatsapp/worker/status', {
      method: 'POST',
      body: { state, phone_number: phoneNumber, message: String(message || '').slice(0, 160) },
    });
  } catch (error) {
    console.warn(`[whatsapp-worker] status update failed (${state}): ${error.message}`);
  }
}

async function sendCommandReply(text) {
  if (!linked || !socket || !text) return;
  await socket.sendMessage(primaryJid, { text: String(text).slice(0, 3900) });
}

async function handleIncoming(message) {
  if (!linked || !socket || message?.key?.fromMe || message?.key?.remoteJid?.endsWith('@g.us')) return;
  const text = messageText(message);
  if (!text) return;
  const sender = normalizePhone(message?.key?.senderPn || message?.key?.remoteJid);
  if (!sender || sender !== primaryNumber) return;

  try {
    const response = await apiRequest('/api/whatsapp/worker/incoming', {
      method: 'POST',
      body: { sender_number: sender, text },
    });
    if (response.authorized && response.reply) await sendCommandReply(response.reply);
  } catch (error) {
    console.warn(`[whatsapp-worker] incoming command could not be processed: ${error.message}`);
    await sendCommandReply('تعذر تنفيذ الأمر الآن بسبب مشكلة اتصال الخدمة. لم يُنفّذ أي حذف جديد. أعد المحاولة لاحقاً.').catch(() => {});
  }
}

function reportMime(filename) {
  return filename.endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv';
}

async function sendOutboxJob(job) {
  if (!job || !job.job_id || !job.lease_id || !linked || !socket) return;
  let success = false;
  let errorText = '';
  const temporaryFiles = [];
  try {
    if (job.recipient && job.recipient !== primaryNumber) {
      throw new Error('Outbox recipient is not the configured WhatsApp number.');
    }
    if (job.text) await socket.sendMessage(primaryJid, { text: String(job.text).slice(0, 3900) });
    const attachments = Array.isArray(job.attachments) ? job.attachments : [];
    for (const filename of attachments) {
      if (!/^sooqify_audit_\d{8}_\d{6}(?:_employees)?\.(?:csv|xlsx)$/.test(filename)) {
        throw new Error('Outbox contained a non-report attachment.');
      }
      const response = await apiRequest(`/api/whatsapp/worker/files/${encodeURIComponent(filename)}`, { raw: true });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 25 * 1024 * 1024) throw new Error('Report attachment exceeded the maximum size.');
      const temporaryFile = path.join(os.tmpdir(), `${crypto.randomUUID()}_${path.basename(filename)}`);
      await fs.writeFile(temporaryFile, buffer, { mode: 0o600, flag: 'wx' });
      temporaryFiles.push(temporaryFile);
      await socket.sendMessage(primaryJid, {
        document: { url: temporaryFile },
        fileName: path.basename(filename),
        mimetype: reportMime(filename),
      });
    }
    success = true;
  } catch (error) {
    errorText = String(error?.message || 'send failed').slice(0, 180);
    console.warn(`[whatsapp-worker] outbox delivery failed: ${errorText}`);
  } finally {
    await Promise.all(temporaryFiles.map(file => fs.rm(file, { force: true }).catch(() => {})));
    try {
      await apiRequest(`/api/whatsapp/worker/outbox/${encodeURIComponent(job.job_id)}/complete`, {
        method: 'POST',
        body: { lease_id: job.lease_id, success, error: errorText },
      });
    } catch (error) {
      console.warn(`[whatsapp-worker] outbox acknowledgement failed: ${error.message}`);
    }
  }
}

async function processOutbox() {
  if (!linked || outboxBusy || stopping) return;
  outboxBusy = true;
  try {
    const response = await apiRequest(`/api/whatsapp/worker/outbox/claim?worker_id=${encodeURIComponent(workerId)}`);
    if (response.job) await sendOutboxJob(response.job);
  } catch (error) {
    // Connectivity failures are retried by the next poll. Do not log message contents or secrets.
    if (!stopping) console.warn(`[whatsapp-worker] outbox poll failed: ${error.message}`);
  } finally {
    outboxBusy = false;
  }
}

async function startSocket() {
  if (stopping || halted) return;
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  try { await fs.chmod(authDir, 0o700); } catch (_) {}
  await updateServiceStatus('connecting');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const current = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    shouldSyncHistoryMessage: () => false,
  });
  socket = current;
  current.ev.on('creds.update', saveCreds);
  current.ev.on('connection.update', async update => {
    if (update.qr) {
      try {
        await apiRequest('/api/whatsapp/worker/pairing-qr', {
          method: 'POST',
          body: { qr: update.qr, expires_seconds: 25 },
        });
        console.log('[whatsapp-worker] temporary pairing QR is available in the dashboard');
      } catch (error) {
        console.warn(`[whatsapp-worker] pairing QR could not be published: ${error.message}`);
      }
    }

    if (update.connection === 'open') {
      const linkedNumber = normalizePhone(current.user?.id || current.user?.jid);
      if (!linkedNumber || linkedNumber !== primaryNumber) {
        linked = false;
        halted = true;
        await updateServiceStatus('number_mismatch', linkedNumber, 'Linked account does not match WHATSAPP_PRIMARY_NUMBER.');
        console.error('[whatsapp-worker] linked WhatsApp number does not match the configured primary number; worker stopped');
        try { current.end(new Error('WhatsApp number mismatch')); } catch (_) {}
        return;
      }
      linked = true;
      await updateServiceStatus('connected', linkedNumber);
      console.log('[whatsapp-worker] linked device connected to the authorized WhatsApp number');
    }

    if (update.connection === 'close') {
      linked = false;
      const reason = update.lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        halted = true;
        await updateServiceStatus('logged_out', '', 'WhatsApp device logged out; pair again from the dashboard.');
        console.warn('[whatsapp-worker] WhatsApp session logged out; re-pairing is required');
        return;
      }
      await updateServiceStatus(stopping ? 'disconnected' : 'connecting', '', stopping ? 'Worker is stopping.' : 'Reconnecting to WhatsApp.');
      if (!stopping && !halted && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startSocket().catch(error => {
            console.error(`[whatsapp-worker] reconnect failed: ${error.message}`);
          });
        }, 2500);
      }
    }
  });
  current.ev.on('messages.upsert', async event => {
    if (event?.type !== 'notify' || !Array.isArray(event.messages)) return;
    for (const message of event.messages) await handleIncoming(message);
  });
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  linked = false;
  console.log(`[whatsapp-worker] stopping (${signal})`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (statusTimer) clearInterval(statusTimer);
  await updateServiceStatus('disconnected', '', 'Worker stopped.');
  try { socket?.end(new Error('Worker shutting down')); } catch (_) {}
}

process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));

async function main() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await startSocket();
  setInterval(() => processOutbox().catch(() => {}), 3500);
  statusTimer = setInterval(() => {
    if (linked) updateServiceStatus('connected', primaryNumber).catch(() => {});
  }, 30_000);
}

main().catch(async error => {
  console.error(`[whatsapp-worker] startup failed: ${String(error?.message || 'unknown error')}`);
  await updateServiceStatus('error', '', 'WhatsApp worker could not start.');
  process.exitCode = 1;
});

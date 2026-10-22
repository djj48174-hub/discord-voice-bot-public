'use strict';

/**
 * حماية السيرفرات 🛡️
 * البوت يشتغل فقط في السيرفرات المصرّح لها:
 *  - سيرفرات مذكورة في ALLOWED_GUILD_IDS (مفصولة بفاصلة)
 *  - أو سيرفر يملكه حساب البوت (BOT_OWNER_ID)
 *  - أو سيرفر أضافه حساب البوت (حسب سجل Discord: BOT_ADD)
 * أي سيرفر ثاني يخرج منه البوت ولا يرد على أحد.
 */

const OWNER_ID = (process.env.BOT_OWNER_ID || '1144389374042185800').trim();
const DEFAULT_ALLOWED = [
  '1506335192355176509', // مجلس الصرامين
  '1528395822952222823', // جحلط
  '1562207103786029077', // u7
].join(',');

const allowed = new Set(
  String(process.env.ALLOWED_GUILD_IDS || DEFAULT_ALLOWED)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);

function isAllowed(guildId) {
  const id = String(guildId || '');
  return Boolean(id) && allowed.has(id);
}

function allow(guildId) {
  const id = String(guildId || '');
  if (id) allowed.add(id);
}

async function verify(guild, client) {
  if (!guild || !guild.id) return false;
  if (isAllowed(guild.id)) return true;
  if (guild.ownerId && guild.ownerId === OWNER_ID) {
    allow(guild.id);
    return true;
  }
  try {
    const logs = await guild.fetchAuditLogs({ type: 28, limit: 50 });
    const entry = logs.entries.find(
      (e) => (e.targetId || e.target?.id) === client.user.id,
    );
    if (entry && entry.executorId === OWNER_ID) {
      allow(guild.id);
      return true;
    }
  } catch {
    // ما عنده صلاحية قراءة سجل التدقيق — نعتبره غير مصرّح
  }
  return false;
}

module.exports = { isAllowed, allow, verify, OWNER_ID, allowed };

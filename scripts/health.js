'use strict';
// فحص صحة البوت: /health + حالة آخر النشرات على Render
// الاستعمال: node scripts/health.js [--json]
const HEALTH_URL =
  process.env.HEALTH_URL || 'https://discord-voice-bot-1jmx.onrender.com/health';
const SERVICE_ID = process.env.RENDER_SERVICE_ID || 'srv-db9mj0qjnfac73cs1bcg';
const API_KEY = process.env.RENDER_API_KEY || '';
const asJson = process.argv.includes('--json');

async function getJson(url, headers, ms = 60000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function deploys() {
  if (!API_KEY) return null;
  try {
    const list = await getJson(
      `https://api.render.com/v1/services/${SERVICE_ID}/deploys?limit=3`,
      { Authorization: `Bearer ${API_KEY}` },
    );
    return (list || []).map((d) => ({
      id: d.deploy?.id,
      status: d.deploy?.status,
      commit: (d.deploy?.commit?.id || '').slice(0, 7),
      at: d.deploy?.createdAt,
    }));
  } catch (e) {
    return { error: String(e.message).slice(0, 80) };
  }
}

async function main() {
  const out = { url: HEALTH_URL, time: new Date().toISOString() };
  try {
    out.health = await getJson(HEALTH_URL, {});
  } catch (e) {
    out.healthError = String(e.message).slice(0, 120);
  }
  out.deploys = await deploys();

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.health ? 0 : 1);
  }

  const h = out.health;
  if (!h) {
    console.log(`❌ ما وصلت للبوت: ${out.healthError || 'خطأ غير معروف'}`);
    if (out.deploys && !out.deploys.error) {
      for (const d of out.deploys) console.log(`   نشرة ${d.commit} — ${d.status}`);
    }
    process.exit(1);
  }

  const up = Number(h.uptime || 0);
  const uptime = up > 3600 ? `${(up / 3600).toFixed(1)} ساعة` : `${Math.round(up / 60)} دقيقة`;
  console.log(`🤖 ${h.bot} — gateway: ${h.gateway} · الروم الصوتي: ${h.voice}`);
  console.log(`⏱️ شغّال من: ${uptime} · أوامر الموسيقى بالصوت: ${h.voiceSongCommands ? 'مفعّلة' : 'مقفلة (من الشات)'}`);

  const guilds = h.guilds || [];
  for (const g of guilds) {
    console.log(
      `🏠 ${g.name}: اتصال=${g.connState || g.voice || '?'} · روم=${g.channel || '-'} · رد صوتي=${g.voiceOn ? 'شغال' : 'موقف'}`,
    );
  }

  const m = h.music;
  console.log(
    `🎵 الموسيقى: ${m ? `${m.status}${m.title ? ` — ${m.title}` : ''}${m.queued ? ` (+${m.queued} بالطابور)` : ''}` : 'ما فيه اتصال'}`,
  );
  if (Array.isArray(h.voiceToggles) && h.voiceToggles.length) {
    const last = h.voiceToggles[h.voiceToggles.length - 1];
    console.log(`🔇 آخر تبديل للرد الصوتي: ${last.on ? 'تشغيل' : 'إيقاف'} — «${String(last.trigger || '').slice(0, 60)}»`);
  }
  if (out.deploys && !out.deploys.error) {
    const d = out.deploys[0] || {};
    console.log(`🚀 آخر نشرة: ${d.commit || '?'} — ${d.status || '?'}`);
  } else if (out.deploys?.error) {
    console.log(`🚀 النشرات: تعذّر الجلب (${out.deploys.error}) — تأكد من RENDER_API_KEY`);
  }
  process.exit(0);
}

main();

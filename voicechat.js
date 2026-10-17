/**
 * المحادثة الصوتية — وحدة الاستقبال.
 *
 * ⚠️ خلفية مهمة: من 2026-03-01 صار تشفير DAVE (E2EE) إلزامياً على ديسكورد،
 * وكان مسار استقبال الصوت في @discordjs/voice مكسوراً (بلاغ #11419).
 * عشان كذا نفحص أول شي: هل توصل بايتات صوت فعلاً؟ وإذا وصلت، نشغّل باقي السلسلة
 * (تفريغ صوتي -> ذكاء اصطناعي -> صوت).
 */

'use strict';

const { EndBehaviorType } = require('@discordjs/voice');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, '[voicechat]', ...args);
}

// كم ننتظر صمت قبل ما نعتبر المقطع انتهى (أعلى = ما نقطع كلامك بالنص)
const SILENCE_MS = Math.max(300, Number(process.env.VOICE_SILENCE_MS || 900));
// أقصى طول للمقطع الواحد (نقطعه لو المستخدم طول)
const MAX_UTTERANCE_MS = Math.max(2000, Number(process.env.VOICE_MAX_MS || 15000));
// أقل طول مقطع نعتبره كلام (نمنع النقرات والضجيج)
const MIN_BYTES = Math.max(0, Number(process.env.VOICE_MIN_BYTES || 1200));

class VoiceChat {
  constructor(conn, opts = {}) {
    this.conn = conn;
    this.onUtterance = typeof opts.onUtterance === 'function' ? opts.onUtterance : null;
    // ملاحظة: حتى لو الرد الصوتي متوقف، نظل نسمع عشان نلتقط أمر "شغّل الرد الصوتي"
    this.enabled = String(process.env.VOICE_CHAT || 'true').toLowerCase() !== 'false';
    this.speaking = false; // البوت يرد حالياً — ما نسمع عشان ما نسجل صوتنا

    this._onStart = null;
    this.subs = new Map();

    // إحصائيات للفحص
    this.stats = {
      segments: 0,
      bytes: 0,
      errors: 0,
      lastAt: null,
      lastBytes: 0,
      speakingEvents: 0,
      enabled: this.enabled,
    };
  }

  /** نمنع الاستقبال مؤقتاً (لما البوت يرد بصوت) */
  setSpeaking(v) {
    this.speaking = Boolean(v);
  }

  /** تشغيل/إيقاف الرد الصوتي (نظل نسمع عشان أمر التشغيل) */
  setEnabled(v) {
    this.enabled = Boolean(v);
    this.stats.enabled = this.enabled;
    return this.enabled;
  }

  start() {
    if (this._onStart) return true;
    const receiver = this.conn?.receiver;
    if (!receiver) {
      log('⚠️ ما فيه receiver — ما أقدر أسمع');
      return false;
    }

    this._onStart = (userId) => this._beginSegment(userId);
    receiver.speaking.on('start', this._onStart);
    // نراقب أحداث الصمت عشان نعرف إذا ديسكورد يرسلها أصلاً
    receiver.speaking.on('end', () => {
      this.stats.speakingEvents++;
    });

    log('👂 جاهز أسمع الروم الصوتي');
    return true;
  }

  stop() {
    if (this._onStart && this.conn?.receiver) {
      this.conn.receiver.speaking.off('start', this._onStart);
    }
    this._onStart = null;
    for (const [, s] of this.subs) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    this.subs.clear();
  }

  _beginSegment(userId) {
    if (this.subs.has(userId)) return; // نتكلم عليه أصلاً
    // ملاحظة: لو البوت يتكلم حالياً نظل نسجّل المقطع (duringSpeech)
    // عشان كلام المستخدم ما يضيع، والبوت يقرر بعدين إذا يتجاهله.

    let stream;
    try {
      stream = this.conn.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
      });
    } catch (e) {
      this.stats.errors++;
      log(`⚠️ تعذّر الاشتراك (${userId}): ${e.message}`);
      return;
    }

    const chunks = [];
    let bytes = 0;
    let packets = 0;
    const t0 = Date.now();
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      this.subs.delete(userId);

      const seconds = (Date.now() - t0) / 1000;
      this.stats.segments++;
      this.stats.bytes += bytes;
      this.stats.lastAt = new Date().toISOString();
      this.stats.lastBytes = bytes;

      if (bytes < MIN_BYTES) {
        log(`🔇 مقطع قصير جداً (${bytes} بايت) — تجاهلته`);
        return;
      }

      log(
        `🎤 مقطع: ${packets} حزمة | ${bytes} بايت | ${seconds.toFixed(1)} ثانية` +
          (bytes / Math.max(0.1, seconds) < 2000 ? ' ⚠️ معدل منخفض' : '') +
          (this.speaking ? ' (البوت يتكلم)' : ''),
      );
      if (this.onUtterance) {
        try {
          this.onUtterance({
            userId,
            packets: chunks.slice(),
            opus: Buffer.concat(chunks),
            seconds,
            count: packets,
            enabled: this.enabled,
            duringSpeech: this.speaking,
          });
        } catch (e) {
          log('⚠️ خطأ في معالجة المقطع:', e.message);
        }
      }
    };

    this.subs.set(userId, stream);

    stream.on('data', (chunk) => {
      bytes += chunk.length;
      packets++;
      if (chunks.length < 8000) chunks.push(chunk);
      if (Date.now() - t0 > MAX_UTTERANCE_MS) {
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
      }
    });

    stream.on('error', (e) => {
      this.stats.errors++;
      log(`⚠️ خطأ في البث (${userId}): ${String(e.message).slice(0, 120)}`);
      finish();
    });
    stream.on('end', finish);
    stream.on('close', finish);
  }
}

module.exports = { VoiceChat };

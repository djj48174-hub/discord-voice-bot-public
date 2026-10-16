/**
 * مُغلِّف Ogg Opus بسيط (بدون مكتبات أصلية).
 *
 * ليش نحتاجه؟
 * ديسكورد يرسل حزم Opus خام (raw) بدون أي حاوية،
 * بينما Groq Whisper يحتاج ملف صوت صالح (ogg/mp3/wav...).
 * بدل ما نركّب مكتبة فك ترميز أصلية (معقدة في Docker)،
 * نغلّف نفس الحزم بـ Ogg — تنسيق معروف ومحدد.
 *
 * التنسيق: RFC 7845 (Opus in Ogg) + حاوية Ogg.
 */

'use strict';

// جدول CRC32 الخاص بـ Ogg (polynom 0x04c11db7، بدون انعكاس)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) {
      r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) : r << 1;
    }
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ buf[i]]) >>> 0;
  }
  return crc >>> 0;
}

function buildPage({ serial, seq, type, granule, packets }) {
  const segments = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      segments.push(255);
      n -= 255;
    }
    segments.push(n);
  }

  const header = Buffer.alloc(27 + segments.length);
  header.write('OggS', 0, 'latin1');
  header[4] = 0; // الإصدار
  header[5] = type; // 0x01 متابعة، 0x02 بداية، 0x04 نهاية
  header.writeBigInt64LE(BigInt(granule || 0), 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(seq >>> 0, 18);
  header.writeUInt32LE(0, 22); // CRC — نحسبه بعدين
  header[26] = segments.length;
  for (let i = 0; i < segments.length; i++) header[27 + i] = segments[i];

  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page) >>> 0, 22);
  return page;
}

/**
 * يغلّف حزم Opus خام بـ Ogg Opus صالح.
 * @param {Buffer[]} packets حزم Opus (بدون حاوية)
 * @param {object} opts
 */
function muxOggOpus(packets, opts = {}) {
  const list = (Array.isArray(packets) ? packets : []).filter((p) => p && p.length > 0);
  if (!list.length) throw new Error('ما فيه حزم صوت لتغليفها');

  const serial = (opts.serial ?? 0x1a2b3c4d) >>> 0;
  const rate = opts.sampleRate || 48000;
  const channels = opts.channels || 2;
  const preSkip = opts.preSkip || 0;
  const vendor = opts.vendor || 'discord-voice';
  const samplesPerPacket = opts.samplesPerPacket || 960; // 20ms عند 48kHz

  // --- OpusHead (19 بايت) ---
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1; // الإصدار
  head[9] = channels;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(rate, 12);
  head.writeUInt16LE(0, 16); // gain
  head[18] = 0; // عائلة القنوات

  // --- OpusTags ---
  const vb = Buffer.from(vendor, 'utf8');
  const tags = Buffer.alloc(8 + 4 + vb.length + 4);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(vb.length, 8);
  vb.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vb.length); // عدد التعليقات

  const pages = [];
  let seq = 0;
  let consumed = 0;

  // الصفحة الأولى (BOS): OpusHead فقط — مثل ملفات opusenc الحقيقية
  pages.push(buildPage({ serial, seq: seq++, type: 0x02, granule: 0, packets: [head] }));
  // الصفحة الثانية: OpusTags
  pages.push(buildPage({ serial, seq: seq++, type: 0x00, granule: 0, packets: [tags] }));

  const PAGE_LIMIT = 4000;
  let cur = [];
  let curSize = 0;

  const flush = (eos) => {
    const granule = (consumed + cur.length) * samplesPerPacket;
    pages.push(buildPage({ serial, seq: seq++, type: eos ? 0x04 : 0x00, granule, packets: cur.slice() }));
    consumed += cur.length;
    cur = [];
    curSize = 0;
  };

  for (const p of list) {
    if (curSize + p.length > PAGE_LIMIT) flush(false);
    cur.push(p);
    curSize += p.length;
  }
  flush(true);

  return Buffer.concat(pages);
}

module.exports = { muxOggOpus, oggCrc };

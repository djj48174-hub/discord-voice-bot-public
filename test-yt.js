// اختبار: هل يوتيوب يعطي بايتات صوت فعلاً؟ (لكل عميل)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const YT = path.join(__dirname, 'bin', 'yt-dlp.exe');
const CLIENTS = ['android', 'tv', 'ios', 'android_vr', 'mweb', 'tv_simply', 'web_embedded', 'web_safari', 'web', 'default'];
const VIDS = process.argv.slice(2).length ? process.argv.slice(2) : ['9lHcn0YvBp0'];

function tryOne(vid, client, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `probe-${client}-${Date.now()}.bin`);
    const args = [
      '-f', 'bestaudio/best', '-o', out,
      '--no-playlist', '--no-part', '--no-progress', '--no-warnings',
    ];
    if (client !== 'default') args.push('--extractor-args', `youtube:player_client=${client}`);
    args.push(`https://www.youtube.com/watch?v=${vid}`);

    const p = spawn(YT, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 3000) err = err.slice(-1500); });

    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.on('close', () => {
      clearTimeout(timer);
      let size = 0;
      try { size = fs.statSync(out).size; } catch {}
      try { fs.unlinkSync(out); } catch {}
      const last = err.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
      const blocked = /Sign in to confirm|not a bot/i.test(err);
      resolve({ size, blocked, last: last.slice(0, 110) });
    });
    p.on('error', (e) => { clearTimeout(timer); resolve({ size: 0, blocked: false, last: e.message }); });
  });
}

(async () => {
  for (const vid of VIDS) {
    console.log(`\n===== الفيديو ${vid} =====`);
    for (const c of CLIENTS) {
      const r = await tryOne(vid, c);
      if (r.size > 0) console.log(`✅ ${c.padEnd(12)} => ${r.size} بايت`);
      else if (r.blocked) console.log(`🚫 ${c.padEnd(12)} => محجوب (Sign in to confirm)`);
      else console.log(`❌ ${c.padEnd(12)} => ${r.last}`);
    }
  }
  process.exit(0);
})();

// تشخيص 3 — مصافحة صوتية يدوية لمعرفة سبب فشل الاتصال
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const WebSocket = require('ws');
const dgram = require('dgram');

const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let voiceState = null;
let voiceServer = null;
let started = false;

function maybeStart() {
  if (started || !voiceState || !voiceServer) return;
  started = true;
  startHandshake(voiceServer, voiceState);
}

client.once('ready', async () => {
  console.log('READY:', client.user.tag);

  client.ws.on('VOICE_STATE_UPDATE', (d) => {
    if (d.user_id === client.user.id && d.session_id) {
      voiceState = d;
      console.log('captured voice state, session_id =', d.session_id);
      maybeStart();
    }
  });
  client.ws.on('VOICE_SERVER_UPDATE', (d) => {
    voiceServer = d;
    console.log('captured voice server, endpoint =', d.endpoint);
    maybeStart();
  });

  console.log('sending op4 join...');
  client.ws.shards.first().send({
    op: 4,
    d: {
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      self_mute: false,
      self_deaf: false,
    },
  });
});

function startHandshake(server, state) {
  const url = `wss://${server.endpoint.replace(/:443$/, '')}/?v=8`;
  console.log('connecting to', url);

  const ws = new WebSocket(url);
  let hb = null;

  ws.on('open', () => console.log('WS OPEN'));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log('non-json:', raw.toString().slice(0, 200));
      return;
    }
    console.log('<<< op', msg.op, msg.op === 2 ? JSON.stringify(msg.d) : '');

    if (msg.op === 8) {
      hb = setInterval(() => ws.send(JSON.stringify({ op: 3, d: Date.now() })), msg.d.heartbeat_interval);
      console.log('>>> identify (op1)');
      ws.send(
        JSON.stringify({
          op: 0,
          d: {
            server_id: server.guild_id,
            user_id: client.user.id,
            session_id: state.session_id,
            token: server.token,
          },
        }),
      );
      return;
    }

    if (msg.op === 2) {
      // READY — نجرب اكتشاف العنوان عبر UDP
      const { ip, port, ssrc } = msg.d;
      console.log('voice server ip/port =', ip, port, 'ssrc =', ssrc);
      doUdpDiscovery(ip, port, ssrc)
        .then((local) => {
          console.log('UDP OK, local =', local);
          console.log('>>> select protocol (op1/udp)');
          ws.send(
            JSON.stringify({
              op: 1,
              d: {
                protocol: 'udp',
                data: { address: local.address, port: local.port, mode: 'xsalsa20_poly1305' },
              },
            }),
          );
        })
        .catch((e) => console.log('UDP FAILED:', e.message));
      return;
    }

    if (msg.op === 4) {
      console.log('*** SESSION DESCRIPTION RECEIVED — الاتصال الصوتي نجح!');
    }

    if (msg.op === 6) {
      console.log('*** HEARTBEAT ACK');
    }
  });

  ws.on('close', (code, reason) => {
    console.log('WS CLOSE code =', code, 'reason =', JSON.stringify(reason.toString()));
    if (hb) clearInterval(hb);
    process.exit(0);
  });

  ws.on('error', (e) => console.log('WS ERROR:', e.message));

  setTimeout(() => {
    console.log('TIMEOUT — ما وصلنا لحل');
    process.exit(0);
  }, 25000);
}

function doUdpDiscovery(ip, port, ssrc) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const packet = Buffer.alloc(74);
    packet.writeUInt16BE(1, 0);
    packet.writeUInt16BE(70, 2);
    packet.writeUInt32BE(ssrc, 4);

    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('UDP timeout (ما وصل رد من السيرفر)'));
    }, 10000);

    sock.on('message', (msg) => {
      clearTimeout(timer);
      const addr = msg.subarray(72, msg.indexOf(0, 72)).toString();
      const p = msg.readUInt16BE(msg.indexOf(0, 72) + 1);
      sock.close();
      resolve({ address: '0.0.0.0', port: p, raw: `${addr}:${p}` });
    });

    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    console.log('UDP: sending discovery to', ip, port);
    sock.send(packet, 0, packet.length, port, ip, (err) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.log('LOGIN FAILED:', e.message);
  process.exit(1);
});

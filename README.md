# بوت ديسكورد 24/7 داخل الروم الصوتي 🎧

بوت يدخل روم صوتي معيّن ويقعد فيه **على مدار الساعة**، وإذا انفصل أو طردوه أو نقله أحد يرجع لحاله.

---

## 📋 معلومات مشروعك (معبّأة مسبقاً)

| الشيء | القيمة |
|---|---|
| اسم البوت | Bot 24/7 |
| ID البوت | `1523559041262026823` |
| ID السيرفر | `1506335192355176509` |
| ID الروم الصوتي | `1533247859095507054` |

كل هذي محفوظة في ملف `.env`.

---

## ✅ الجزء 1 — التجربة على جهازك (تأكيد إنه يشتغل)

من مجلد المشروع شغّل:

```powershell
npm install
npm start
```

المفروض تشوف بالسجل:

```
✅ دخلت الروم الصوتي: <اسم الروم>
```

الحين البوت موجود داخل الروم في ديسكورد. **بس** لو طفّيت جهازك بيطلع — عشان كذا نحتاج الجزء 2.

الأوامر المتاحة داخل ديسكورد:

| الأمر | الوظيفة |
|---|---|
| `/join` | يدخل الروم ويشغّل الرجوع التلقائي |
| `/leave` | يطلع ويوقف الرجوع التلقائي |
| `/status` | يعرض الحالة الحالية |

---

## ☁️ الجزء 2 — التشغيل 24/7 على Oracle Cloud (مجاني للأبد)

### الخطوة 1: سجّل في Oracle Cloud

1. روح إلى <https://www.oracle.com/cloud/free/>
2. اضغط **Start for free** وسجّل (يطلب بطاقة للتحقق فقط — **ما يُخصم منها شي** على الخطة المجانية).
3. اختر **Home Region** قريب منك (أوروبا/الشرق الأوسط أسرع من أمريكا).

### الخطوة 2: أنشئ سيرفر (Instance)

1. من القائمة: **Compute → Instances → Create Instance**
2. **Name**: `discord-bot`
3. **Image**: `Ubuntu` → النسخة `22.04` أو `24.04`
4. **Shape**: اختر
   - `VM.Standard.A1.Flex` (ARM) — مجاني للأبد، ممتاز. اقترح 1 OCPU / 6 GB.
   - أو `VM.Standard.E2.1.Micro` (AMD) — أضعف بس يكفي للبوت.
   > لو طلع خطأ "Out of capacity" للـ ARM، جرّب **Availability Domain** ثاني، أو استخدم E2.1.Micro.
5. **Add SSH keys** → اختر **Generate a key pair for me** → نزّل **Private key** (ملف `.key`) و **Public key**.
6. اضغط **Create**.

### الخطوة 3: اتصل بالسيرفر من ويندوز

افتح PowerShell في مجلد المفتاح:

```powershell
ssh -i .\ssh-key-2026-01-01.key ubuntu@<PUBLIC_IP>
```

(IP تلاقيه في صفحة الـ Instance تحت **Public IP address**)

> لو طلع خطأ عن صلاحيات المفتاح:
> ```powershell
> icacls .\ssh-key-2026-01-01.key /inheritance:r
> icacls .\ssh-key-2026-01-01.key /grant:r "$($env:USERNAME):R"
> ```

### الخطوة 4: ارفع ملفات المشروع

من PowerShell **بجهازك** (مو داخل السيرفر)، وأنت واقف في مجلد المشروع:

```powershell
# أنشئ المجلد على السيرفر
ssh -i .\ssh-key.key ubuntu@<PUBLIC_IP> "mkdir -p ~/discord-voice-bot"

# ارفع الملفات (بدون node_modules)
scp -i .\ssh-key.key bot.js package.json .env setup_server.sh discord-voice-bot.service ubuntu@<PUBLIC_IP>:~/discord-voice-bot/
```

### الخطوة 5: شغّل سكربت التجهيز

داخل السيرفر (بعد `ssh`) نفّذ:

```bash
cd ~/discord-voice-bot
bash setup_server.sh
```

السكربت يسوي كل شي: يثبّت Node، يثبّت المكتبات، ويسجّل البوت كخدمة تشتغل تلقائياً وترجع تشتغل لو طاح أو السيرفر أعاد التشغيل.

### الخطوة 6: تأكد إنه شغّال

```bash
sudo systemctl status discord-voice-bot
tail -f ~/discord-voice-bot/bot.log
```

المفروض تشوف `✅ دخلت الروم الصوتي`.

**خلص!** من الحين، حتى لو طفّيت جهازك، البوت يبقى داخل الروم 24/7. 🎉

---

## 🛠️ أوامر إدارة الخدمة (على السيرفر)

| الأمر | الوظيفة |
|---|---|
| `sudo systemctl status discord-voice-bot` | حالة البوت |
| `tail -f ~/discord-voice-bot/bot.log` | متابعة السجل مباشرة |
| `sudo systemctl restart discord-voice-bot` | إعادة تشغيل |
| `sudo systemctl stop discord-voice-bot` | إيقاف مؤقت |
| `sudo systemctl start discord-voice-bot` | تشغيل |

### تحديث الكود لاحقاً

```bash
cd ~/discord-voice-bot
# ارفع bot.js الجديد من جهازك، بعدين:
sudo systemctl restart discord-voice-bot
```

---

## ⚠️ ملاحظات مهمة

1. **الأمان**: ملف `.env` يحتوي توكن البوت. لا ترفعه على GitHub ولا تشاركه.
   لو انكشف، سوّي **Reset Token** من <https://discord.com/developers/applications> → Bot → Reset Token، وحدّث ملف `.env`.

2. **صلاحيات البوت في السيرفر**: لازم يكون عنده صلاحية **Connect** على الروم الصوتي و **View Channel**.

3. **حد الأماكن**: لو الروم فيه `user_limit` (حد أقصى للأعضاء) والبوت ما قدر يدخل — ارفع الحد أو ألغِه.

4. **الروم ما ينفصل**: البوت ما يعتمد على الصوت نفسه، بس يبقى متصلاً. لو سيرفرك فيه **AFK Timeout**، البوت يرجع للروم المحدد تلقائياً لأنه مضبوط `LOCK_TO_CHANNEL=true`.

5. **التكلفة**: خطة Oracle **Always Free** ما تُحسب عليها فلوس طالما تستخدم الأشكال المجانية (مكتوب جنبها "Always Free"). لكن Oracle تقدر تحذف السيرفر إذا كان **خامل فترة طويلة جدًا** — البوت شغّال 24/7 فما فيه خمول.

---

## 📁 ملفات المشروع

| الملف | الوصف |
|---|---|
| `bot.js` | كود البوت |
| `package.json` | المكتبات المطلوبة |
| `.env` | الإعدادات والتوكن (سري) |
| `.env.example` | نموذج للإعدادات |
| `setup_server.sh` | سكربت تجهيز السيرفر تلقائياً |
| `discord-voice-bot.service` | ملف خدمة systemd (بديل يدوي) |

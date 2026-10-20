/**
 * فلتر القذف والسب 🚫
 * يكشف الكلمات المسيئة (عربي + إنجليزي) ويطبّق: حذف الرسالة + تايم أوت ساعة.
 * ملاحظة: الفلتر الأساسي هو AutoMod في ديسكورد (يشوف كل الرسائل)؛
 * هذا الفلتر احتياطي للرسائل اللي تصل للبوت.
 */

'use strict';

const TIMEOUT_MS = 60 * 60 * 1000; // ساعة كاملة

// كلمات ممنوعة (بعد التطبيع: بدون تشكيل، أ/إ/آ => ا، ى => ي، ة => ه)
const BAD_WORDS = [
  'كلب', 'كلبه', 'ابن الكلب', 'ابن الكلب',
  'حمار', 'حماره', 'بهيم', 'حيوان',
  'غبي', 'غبيه', 'تافه', 'تافهه', 'حقير', 'حقيره', 'منحط', 'سافل',
  'خنزير', 'خنزيره', 'قذر', 'قذره', 'وسخ', 'زباله', 'حثاله',
  'لعنه', 'ملعون', 'يلعن', 'يلعنك',
  'قحبه', 'شرموط', 'شرموطه', 'عاهر', 'عاهره',
  'عرص', 'خول', 'دياثه', 'قواد', 'ساقطه', 'فاسق', 'فاسقه',
  'زاني', 'زانيه', 'منيوك', 'منيوكه', 'متناك', 'متناكه',
  'طيز', 'زب', 'كس', 'نيك', 'لبوه', 'لبوه', 'خرا', 'خريه',
  'شرموط', 'كس اختك', 'كس امك', 'يلعن ابوك',
];

const BAD_EN = [
  'fuck', 'fucking', 'bitch', 'asshole', 'bastard', 'whore', 'slut',
  'retard', 'nigga', 'nigger', 'cunt', 'dickhead', 'motherfucker',
  'shit', 'dumbass',
];

const AR_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

function normalizeArabic(text) {
  return String(text || '')
    .toLowerCase()
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLoose(text) {
  return normalizeArabic(text)
    .replace(/\s+/g, '')
    // إطالة الحروف: "كلببب" => "كلب"
    .replace(/(.)\1+/g, '$1');
}

const NORMAL_WORDS = BAD_WORDS.map(normalizeArabic);
const NORMAL_EN = BAD_EN.map((w) => w.toLowerCase());

const PHRASES = ['ابن الكلب', 'كس امك', 'كس اختك', 'يلعن ابوك'];

/**
 * يرجع الكلمة اللي انكشف بها أو null.
 */
function detect(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 1500) return null;

  const norm = normalizeArabic(raw);
  if (!norm) return null;

  const padded = ` ${norm} `;

  for (const phrase of PHRASES) {
    if (padded.includes(` ${phrase} `)) return phrase;
  }

  const words = norm.split(' ').filter(Boolean);
  for (const w of words) {
    if (NORMAL_WORDS.includes(w)) return w;
    // "كلبك" / "غبيك" — كلمة ممنوعة ملتصقة بضمير
    for (const bad of NORMAL_WORDS) {
      if (bad.length >= 3 && w.startsWith(bad) && w.length - bad.length <= 2) return bad;
    }
    if (NORMAL_EN.includes(w)) return w;
  }

  // حروف متباعدة: "ك ل ب" — نتأكد فقط للنصوص القصيرة
  const compactAll = normalizeLoose(raw);
  if (compactAll.length <= 20) {
    for (const bad of NORMAL_WORDS) {
      if (bad.length >= 3 && compactAll === normalizeLoose(bad)) return bad;
    }
  }

  // إنجليزي داخل نص
  for (const bad of NORMAL_EN) {
    if (new RegExp(`\\b${bad}\\b`, 'i').test(raw)) return bad;
  }

  return null;
}

module.exports = { detect, TIMEOUT_MS };

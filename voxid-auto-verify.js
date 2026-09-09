/**
 * VoxID — Auto-vérification (OCR uniquement, version allégée)
 * ---------------------------------------------------------------
 * La détection de visage (face-api.js + canvas) a été retirée : elle faisait planter
 * le serveur par manque de mémoire sur l'instance Render gratuite (512 Mo).
 * On garde uniquement l'OCR (Tesseract.js) + comparaison fuzzy du nom, ce qui reste
 * largement suffisant pour filtrer les cas évidents et reste léger en mémoire.
 *
 * Compromis assumé : on ne vérifie plus qu'un visage net est présent sur la photo.
 * Le seuil d'auto-approbation est relevé en conséquence pour compenser.
 */

const Tesseract = require('tesseract.js');
const stringSimilarity = require('string-similarity');

async function ocrExtractText(documentPhotoDataUrl) {
  const { data } = await Tesseract.recognize(documentPhotoDataUrl, 'fra');
  return (data.text || '').replace(/\s+/g, ' ').trim();
}

function nameMatchScore(fullName, ocrText) {
  const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const nameN = normalize(fullName);
  const ocrN = normalize(ocrText);
  if (!nameN || !ocrN) return 0;

  const words = nameN.split(' ');
  const variants = [nameN, words.slice().reverse().join(' ')];
  let best = 0;
  for (const variant of variants) {
    best = Math.max(best, stringSimilarity.compareTwoStrings(variant, ocrN));
  }
  const wordsFound = words.filter(w => w.length > 1 && ocrN.includes(w)).length;
  const wordCoverage = words.length ? wordsFound / words.length : 0;
  return Math.max(best, wordCoverage * 0.9);
}

async function autoVerify({ fullName, documentPhotoDataUrl }) {
  try {
    const ocrText = await ocrExtractText(documentPhotoDataUrl).catch(() => '');
    const confidence = Math.round(nameMatchScore(fullName, ocrText) * 100) / 100;

    // Seuil relevé (plus de vérification visage pour compenser) : on ne s'auto-approuve
    // que si le nom est retrouvé de façon très nette dans le texte OCR.
    const AUTO_APPROVE_THRESHOLD = 0.82;

    if (confidence >= AUTO_APPROVE_THRESHOLD) {
      return { autoApprove: true, confidence, reason: 'ok' };
    }
    return { autoApprove: false, confidence, reason: 'name_mismatch_or_low_confidence' };
  } catch (err) {
    return { autoApprove: false, confidence: 0, reason: 'ocr_error:' + err.message };
  }
}

module.exports = { autoVerify, ocrExtractText, nameMatchScore };

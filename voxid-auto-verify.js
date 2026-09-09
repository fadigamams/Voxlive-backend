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
const crypto = require('crypto');

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

/**
 * Extrait un numéro de pièce probable du texte OCR (CNI, carte d'électeur, carte de membre...).
 * Ne sert JAMAIS à afficher ou stocker le numéro en clair — uniquement à calculer une empreinte
 * (hash) pour détecter si la même pièce est réutilisée sur plusieurs comptes (anti multi-votes).
 * Reconnaît le format CNI ivoirien (ex: CI000735916) et, à défaut, toute séquence de 8 à 13 chiffres.
 */
function extractDocumentNumber(ocrText) {
  if (!ocrText) return null;
  const ciMatch = ocrText.match(/\bC[il1][\s.]?0*\d{6,10}\b/i);
  if (ciMatch) {
    return ciMatch[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  const digitsMatch = ocrText.match(/\b\d{8,13}\b/);
  if (digitsMatch) {
    return digitsMatch[0];
  }
  return null;
}

function hashDocumentNumber(number) {
  if (!number) return null;
  return crypto.createHash('sha256').update(number).digest('hex');
}

async function autoVerify({ fullName, documentPhotoDataUrl }) {
  try {
    const ocrText = await ocrExtractText(documentPhotoDataUrl).catch(() => '');
    const confidence = Math.round(nameMatchScore(fullName, ocrText) * 100) / 100;
    const documentNumberHash = hashDocumentNumber(extractDocumentNumber(ocrText));

    // Seuil relevé (plus de vérification visage pour compenser) : on ne s'auto-approuve
    // que si le nom est retrouvé de façon très nette dans le texte OCR.
    const AUTO_APPROVE_THRESHOLD = 0.82;

    if (confidence >= AUTO_APPROVE_THRESHOLD) {
      return { autoApprove: true, confidence, reason: 'ok', documentNumberHash };
    }
    return { autoApprove: false, confidence, reason: 'name_mismatch_or_low_confidence', documentNumberHash };
  } catch (err) {
    return { autoApprove: false, confidence: 0, reason: 'ocr_error:' + err.message, documentNumberHash: null };
  }
}

module.exports = { autoVerify, ocrExtractText, nameMatchScore, extractDocumentNumber, hashDocumentNumber };

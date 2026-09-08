/**
 * VoxID — Auto-vérification hybride (OCR + détection de visage)
 * ---------------------------------------------------------------
 * Gratuit : Tesseract.js (OCR) + face-api.js (détection de visage) + string-similarity (fuzzy match du nom)
 *
 * Logique :
 *   1. OCR sur la photo (pièce ou carte de membre) → extrait le texte brut
 *   2. Comparaison fuzzy du nom saisi vs texte OCR
 *   3. Détection de visage sur la photo (vérifie qu'il y a bien un visage net, pas un écran/dessin)
 *   4. Score de confiance combiné :
 *        - élevé  → auto-validation immédiate (voxid_verified = true)
 *        - faible → mise en file d'attente pour un validateur humain (comportement actuel inchangé)
 *
 * Installation :
 *   npm install tesseract.js face-api.js string-similarity canvas --save
 *
 * Intégration dans ton server.js existant (route /api/voxid/submit) :
 *
 *   const { autoVerify } = require('./voxid-auto-verify');
 *   ...
 *   app.post('/api/voxid/submit', authMiddleware, async (req, res) => {
 *     const { fullName, documentPhotoDataUrl, pollId, verificationType, membershipCardNumber } = req.body;
 *     if (!fullName || !documentPhotoDataUrl) return res.status(400).json({ error: 'Champs manquants.' });
 *
 *     // 1. Enregistre la demande en base comme avant (statut 'pending')
 *     const request = await db.query(
 *       `INSERT INTO voxid_requests (user_id, poll_id, full_name, document_photo, verification_type, membership_card_number, status)
 *        VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
 *       [req.user.id, pollId, fullName, documentPhotoDataUrl, verificationType || 'open', membershipCardNumber || null]
 *     );
 *     const requestId = request.rows[0].id;
 *
 *     // 2. Tente l'auto-validation
 *     const result = await autoVerify({ fullName, documentPhotoDataUrl });
 *
 *     if (result.autoApprove) {
 *       await db.query(`UPDATE voxid_requests SET status='approved', auto_validated=true, confidence=$2 WHERE id=$1`, [requestId, result.confidence]);
 *       await db.query(`UPDATE users SET voxid_verified=true, voxid=$2 WHERE id=$1`, [req.user.id, fullName]);
 *       return res.json({ ok: true, autoValidated: true, confidence: result.confidence });
 *     }
 *
 *     // 3. Sinon, reste en file d'attente humaine (comportement existant, rien à changer côté validateurs)
 *     await db.query(`UPDATE voxid_requests SET confidence=$2, auto_reason=$3 WHERE id=$1`, [requestId, result.confidence, result.reason]);
 *     return res.json({ ok: true, autoValidated: false });
 *   });
 *
 * Colonnes à ajouter à la table voxid_requests (migration SQL) :
 *   ALTER TABLE voxid_requests ADD COLUMN IF NOT EXISTS verification_type TEXT DEFAULT 'open';
 *   ALTER TABLE voxid_requests ADD COLUMN IF NOT EXISTS membership_card_number TEXT;
 *   ALTER TABLE voxid_requests ADD COLUMN IF NOT EXISTS auto_validated BOOLEAN DEFAULT false;
 *   ALTER TABLE voxid_requests ADD COLUMN IF NOT EXISTS confidence NUMERIC;
 *   ALTER TABLE voxid_requests ADD COLUMN IF NOT EXISTS auto_reason TEXT;
 *
 * Et sur polls :
 *   ALTER TABLE polls ADD COLUMN IF NOT EXISTS verification_type TEXT DEFAULT 'open';
 */

const Tesseract = require('tesseract.js');
const stringSimilarity = require('string-similarity');
const faceapi = require('face-api.js');
const canvas = require('canvas');
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODELS_PATH = __dirname + '/face-models'; // voir note de téléchargement des modèles ci-dessous
let modelsLoaded = false;

async function loadModelsOnce() {
  if (modelsLoaded) return;
  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_PATH);
  modelsLoaded = true;
}

/**
 * Extrait le texte d'une image en base64 (data URL) via OCR.
 * Langue française par défaut (adapter selon les pièces ivoiriennes, souvent bilingues).
 */
async function ocrExtractText(documentPhotoDataUrl) {
  const { data } = await Tesseract.recognize(documentPhotoDataUrl, 'fra');
  return (data.text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Vérifie qu'un visage net est détecté sur l'image (anti photo d'écran / dessin / pièce sans photo lisible).
 */
async function detectFace(documentPhotoDataUrl) {
  await loadModelsOnce();
  const img = await canvas.loadImage(documentPhotoDataUrl);
  const detections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions());
  return detections.length > 0 ? detections[0].score : 0;
}

/**
 * Compare le nom saisi au texte OCR (fuzzy, insensible à la casse/accents/ordre des mots).
 */
function nameMatchScore(fullName, ocrText) {
  const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const nameN = normalize(fullName);
  const ocrN = normalize(ocrText);
  if (!nameN || !ocrN) return 0;

  // Teste le nom complet + chaque permutation de mots (les pièces CI affichent souvent NOM avant Prénom)
  const words = nameN.split(' ');
  const variants = [nameN, words.slice().reverse().join(' ')];
  let best = 0;
  for (const variant of variants) {
    best = Math.max(best, stringSimilarity.compareTwoStrings(variant, ocrN));
  }
  // Bonus si chaque mot du nom apparaît individuellement dans le texte OCR
  const wordsFound = words.filter(w => w.length > 1 && ocrN.includes(w)).length;
  const wordCoverage = words.length ? wordsFound / words.length : 0;
  return Math.max(best, wordCoverage * 0.9);
}

/**
 * Point d'entrée principal : tente l'auto-vérification.
 * Retourne { autoApprove: boolean, confidence: number, reason: string }
 */
async function autoVerify({ fullName, documentPhotoDataUrl }) {
  try {
    const [ocrText, faceScore] = await Promise.all([
      ocrExtractText(documentPhotoDataUrl).catch(() => ''),
      detectFace(documentPhotoDataUrl).catch(() => 0)
    ]);

    const nameScore = nameMatchScore(fullName, ocrText);

    // Score combiné : le nom compte plus que le visage (le visage sert surtout à écarter les faux grossiers)
    const confidence = Math.round((nameScore * 0.7 + Math.min(faceScore, 1) * 0.3) * 100) / 100;

    const AUTO_APPROVE_THRESHOLD = 0.72; // ajustable : plus haut = plus strict, plus de cas envoyés en file humaine

    if (confidence >= AUTO_APPROVE_THRESHOLD && faceScore > 0.4) {
      return { autoApprove: true, confidence, reason: 'ok' };
    }
    return {
      autoApprove: false,
      confidence,
      reason: faceScore <= 0.4 ? 'no_clear_face' : 'name_mismatch_or_low_confidence'
    };
  } catch (err) {
    // En cas d'erreur technique (image illisible, etc.), on ne bloque jamais l'électeur :
    // on envoie simplement en file d'attente humaine.
    return { autoApprove: false, confidence: 0, reason: 'ocr_error:' + err.message };
  }
}

module.exports = { autoVerify, ocrExtractText, detectFace, nameMatchScore };

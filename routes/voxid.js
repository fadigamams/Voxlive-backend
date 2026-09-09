const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { autoVerify } = require('../voxid-auto-verify');

const router = express.Router();

const MAX_PHOTO_BYTES = 2_000_000; // ~2 Mo en base64, cohérent avec la limite déjà utilisée pour le logo de compte

function generateVoxId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let part = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `VXID-${part()}-${part()}`;
}

function hashPhoto(dataUrl) {
  return crypto.createHash('sha256').update(dataUrl).digest('hex');
}

/* ---------- Soumettre une demande de vérification VoxID ---------- */
router.post('/submit', requireAuth, async (req, res) => {
  try {
    const { fullName, documentPhotoDataUrl, pollId, deviceFingerprint, verificationType, membershipCardNumber } = req.body || {};
    const vType = verificationType === 'strict' ? 'strict' : 'open';

    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ error: 'Le nom complet est requis.' });
    }
    if (!documentPhotoDataUrl || !documentPhotoDataUrl.startsWith('data:image')) {
      return res.status(400).json({ error: vType === 'strict' ? 'Une photo de ta carte de membre est requise.' : 'Une photo de pièce d\'identité est requise.' });
    }
    if (documentPhotoDataUrl.length > MAX_PHOTO_BYTES) {
      return res.status(400).json({ error: 'Photo trop volumineuse (2 Mo maximum), réessaie avec une image plus légère.' });
    }
    if (!pollId) {
      return res.status(400).json({ error: 'Cette demande doit être liée à une élection sensible précise.' });
    }
    if (vType === 'strict' && (!membershipCardNumber || !membershipCardNumber.trim())) {
      return res.status(400).json({ error: 'Le numéro de carte de membre est requis pour cette élection.' });
    }

    const pollRes = await pool.query('SELECT id, user_id, security_level, verification_type FROM polls WHERE id::text = $1 OR code = $1', [pollId]);
    const poll = pollRes.rows[0];
    if (!poll) return res.status(404).json({ error: 'Élection introuvable.' });

    if (vType === 'open') {
      // Comportement inchangé : une vérification "ouverte" déjà active couvre toutes les élections ouvertes.
      const { rows: uRows } = await pool.query('SELECT voxid_verified FROM users WHERE id = $1', [req.user.sub]);
      if (uRows[0]?.voxid_verified) {
        return res.status(409).json({ error: 'Ton identité est déjà vérifiée (VoxID actif).' });
      }
    } else {
      // Mode strict : la vérification est propre à CETTE élection, même si le compte est déjà VoxID-vérifié ailleurs.
      const { rows: alreadyApproved } = await pool.query(
        `SELECT id FROM verification_requests WHERE user_id = $1 AND poll_id = $2 AND status = 'approved'`,
        [req.user.sub, poll.id]
      );
      if (alreadyApproved[0]) {
        return res.status(409).json({ error: 'Tu es déjà vérifié pour cette élection.' });
      }
    }

    // Déjà une demande en attente pour CETTE élection ?
    const { rows: pending } = await pool.query(
      "SELECT id FROM verification_requests WHERE user_id = $1 AND poll_id = $2 AND status = 'pending'",
      [req.user.sub, poll.id]
    );
    if (pending[0]) {
      return res.status(409).json({ error: 'Une demande de vérification est déjà en attente pour cette élection.' });
    }

    // Choisir un validateur : parmi ceux désignés pour cette élection, celui avec le moins de dossiers en attente ; sinon l'organisateur.
    const { rows: validators } = await pool.query(
      `SELECT pv.validator_user_id AS id,
              (SELECT COUNT(*) FROM verification_requests vr WHERE vr.assigned_validator = pv.validator_user_id AND vr.status = 'pending') AS load
       FROM poll_validators pv WHERE pv.poll_id = $1
       ORDER BY load ASC LIMIT 1`,
      [poll.id]
    );
    const assignedValidator = validators[0]?.id || poll.user_id;

    const photoHash = hashPhoto(documentPhotoDataUrl);

    const { rows: inserted } = await pool.query(
      `INSERT INTO verification_requests
         (user_id, poll_id, full_name_submitted, document_photo_url, photo_hash, device_fingerprint, assigned_validator, verification_type, membership_card_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, status, created_at`,
      [req.user.sub, poll.id, fullName.trim(), documentPhotoDataUrl, photoHash, deviceFingerprint || null, assignedValidator, vType, vType === 'strict' ? membershipCardNumber.trim() : null]
    );
    const requestId = inserted[0].id;

    // Détection basique de doublon de photo (même image déjà utilisée par un AUTRE compte, approuvée)
    const { rows: dupRows } = await pool.query(
      `SELECT DISTINCT user_id FROM verification_requests
       WHERE photo_hash = $1 AND user_id <> $2 AND status = 'approved'`,
      [photoHash, req.user.sub]
    );
    if (dupRows.length > 0) {
      await pool.query(
        `INSERT INTO fraud_signals (poll_id, signal_type, severity, details)
         VALUES ($1, 'duplicate_photo', 4, $2)`,
        [poll.id, JSON.stringify({ request_id: requestId, matched_user_ids: dupRows.map(r=>r.user_id) })]
      );
      // Doublon détecté : jamais d'auto-validation, direction file d'attente humaine.
      return res.status(201).json({ request: inserted[0], autoValidated: false });
    }

    // ---------- Auto-validation en arrière-plan (ne bloque jamais la réponse HTTP) ----------
    // L'OCR + la détection de visage peuvent prendre 10-30s (surtout après une mise en veille Render) :
    // on répond immédiatement au client, puis on met à jour la demande une fois l'analyse terminée.
    runAutoVerifyInBackground({ requestId, fullName: fullName.trim(), documentPhotoDataUrl, vType, userId: req.user.sub });

    res.status(201).json({ request: inserted[0], autoValidated: false, processing: true });
  } catch (err) {
    console.error('Erreur POST /voxid/submit :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

/**
 * Auto-validation asynchrone : ne fait jamais attendre le client. Toute erreur ici est loguée
 * mais laisse simplement la demande en 'pending' pour un validateur humain (jamais bloquant).
 */
async function runAutoVerifyInBackground({ requestId, fullName, documentPhotoDataUrl, vType, userId }) {
  try {
    const auto = await autoVerify({ fullName, documentPhotoDataUrl });

    await pool.query(
      `UPDATE verification_requests SET confidence = $1, auto_reason = $2 WHERE id = $3`,
      [auto.confidence, auto.reason, requestId]
    );

    if (!auto.autoApprove) return; // reste en file d'attente humaine, rien d'autre à faire

    await pool.query(
      `UPDATE verification_requests SET status = 'approved', auto_validated = TRUE, reviewed_at = now() WHERE id = $1 AND status = 'pending'`,
      [requestId]
    );

    if (vType === 'open') {
      let voxid, done;
      for (let i = 0; i < 5 && !done; i++) {
        voxid = generateVoxId();
        try {
          await pool.query(
            'UPDATE users SET voxid = $1, voxid_verified = TRUE WHERE id = $2 AND voxid IS NULL',
            [voxid, userId]
          );
          done = true;
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
      await pool.query('UPDATE users SET voxid_verified = TRUE WHERE id = $1', [userId]);
    }
    // Mode strict : l'approbation reste au niveau de la demande (poll_id précis), pas de flag global.
  } catch (err) {
    console.error('Erreur auto-validation VoxID (arrière-plan) :', err);
    // On ne touche pas au statut : la demande reste 'pending', un validateur humain la traitera normalement.
  }
}

/* ---------- Vérifier le statut d'une demande (polling léger côté app) ---------- */
router.get('/:requestId/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, auto_validated FROM verification_requests WHERE id = $1 AND user_id = $2`,
      [req.params.requestId, req.user.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Demande introuvable.' });
    res.json({ request: rows[0] });
  } catch (err) {
    console.error('Erreur GET /voxid/:requestId/status :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

/* ---------- File d'attente d'un validateur (interface swipe) ---------- */
router.get('/queue', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT vr.id, vr.full_name_submitted, vr.document_photo_url, vr.created_at,
              vr.verification_type, vr.membership_card_number, vr.confidence, vr.auto_reason,
              p.title AS poll_title, p.code AS poll_code
       FROM verification_requests vr
       JOIN polls p ON p.id = vr.poll_id
       WHERE vr.status = 'pending'
         AND (vr.assigned_validator = $1 OR p.user_id = $1)
       ORDER BY vr.created_at ASC
       LIMIT 20`,
      [req.user.sub]
    );
    res.json({ queue: rows });
  } catch (err) {
    console.error('Erreur GET /voxid/queue :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

/* ---------- Décision du validateur (swipe) ---------- */
router.post('/:requestId/decide', requireAuth, async (req, res) => {
  try {
    const { decision } = req.body || {};
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Décision invalide.' });
    }

    const { rows } = await pool.query(
      `SELECT vr.id, vr.user_id, vr.status, vr.assigned_validator, vr.verification_type, p.user_id AS poll_owner
       FROM verification_requests vr
       JOIN polls p ON p.id = vr.poll_id
       WHERE vr.id = $1`,
      [req.params.requestId]
    );
    const request = rows[0];
    if (!request) return res.status(404).json({ error: 'Demande introuvable.' });
    if (request.assigned_validator !== req.user.sub && request.poll_owner !== req.user.sub) {
      return res.status(403).json({ error: "Tu n'es pas autorisé à valider cette demande." });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({ error: 'Cette demande a déjà été traitée.' });
    }

    await pool.query(
      `UPDATE verification_requests SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3`,
      [decision, req.user.sub, request.id]
    );

    if (decision === 'approved' && request.verification_type !== 'strict') {
      let voxid, done;
      for (let i = 0; i < 5 && !done; i++) {
        voxid = generateVoxId();
        try {
          await pool.query(
            'UPDATE users SET voxid = $1, voxid_verified = TRUE WHERE id = $2 AND voxid IS NULL',
            [voxid, request.user_id]
          );
          done = true;
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
      // si l'utilisateur avait déjà un voxid (cas rare), s'assurer que le badge est bien actif
      await pool.query('UPDATE users SET voxid_verified = TRUE WHERE id = $1', [request.user_id]);
    }
    // Mode strict approuvé : rien à toucher côté users, l'approbation vaut uniquement pour ce poll_id précis.

    res.json({ ok: true, decision });
  } catch (err) {
    console.error('Erreur POST /voxid/:requestId/decide :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

module.exports = router;

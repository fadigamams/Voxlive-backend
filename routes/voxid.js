const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

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
    const { fullName, documentPhotoDataUrl, pollId, deviceFingerprint } = req.body || {};
    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ error: 'Le nom complet est requis.' });
    }
    if (!documentPhotoDataUrl || !documentPhotoDataUrl.startsWith('data:image')) {
      return res.status(400).json({ error: 'Une photo de pièce d\'identité est requise.' });
    }
    if (documentPhotoDataUrl.length > MAX_PHOTO_BYTES) {
      return res.status(400).json({ error: 'Photo trop volumineuse (2 Mo maximum), réessaie avec une image plus légère.' });
    }
    if (!pollId) {
      return res.status(400).json({ error: 'Cette demande doit être liée à une élection sensible précise.' });
    }

    const pollRes = await pool.query('SELECT id, user_id, security_level FROM polls WHERE id::text = $1 OR code = $1', [pollId]);
    const poll = pollRes.rows[0];
    if (!poll) return res.status(404).json({ error: 'Élection introuvable.' });

    // Déjà vérifié ? Pas besoin de refaire une demande.
    const { rows: uRows } = await pool.query('SELECT voxid_verified FROM users WHERE id = $1', [req.user.sub]);
    if (uRows[0]?.voxid_verified) {
      return res.status(409).json({ error: 'Ton identité est déjà vérifiée (VoxID actif).' });
    }

    // Déjà une demande en attente ?
    const { rows: pending } = await pool.query(
      "SELECT id FROM verification_requests WHERE user_id = $1 AND status = 'pending'",
      [req.user.sub]
    );
    if (pending[0]) {
      return res.status(409).json({ error: 'Une demande de vérification est déjà en attente pour ce compte.' });
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
         (user_id, poll_id, full_name_submitted, document_photo_url, photo_hash, device_fingerprint, assigned_validator)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, status, created_at`,
      [req.user.sub, poll.id, fullName.trim(), documentPhotoDataUrl, photoHash, deviceFingerprint || null, assignedValidator]
    );

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
        [poll.id, JSON.stringify({ request_id: inserted[0].id, matched_user_ids: dupRows.map(r=>r.user_id) })]
      );
    }

    res.status(201).json({ request: inserted[0] });
  } catch (err) {
    console.error('Erreur POST /voxid/submit :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

/* ---------- File d'attente d'un validateur (interface swipe) ---------- */
router.get('/queue', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT vr.id, vr.full_name_submitted, vr.document_photo_url, vr.created_at,
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
      `SELECT vr.id, vr.user_id, vr.status, vr.assigned_validator, p.user_id AS poll_owner
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

    if (decision === 'approved') {
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

    res.json({ ok: true, decision });
  } catch (err) {
    console.error('Erreur POST /voxid/:requestId/decide :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

module.exports = router;

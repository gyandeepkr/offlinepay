const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { verifySignature } = require('../utils/crypto');

const router = express.Router();

const TX_CORE_FIELDS = ['id', 'senderId', 'receiverId', 'amount', 'timestamp'];

function corePayload(tx) {
  const core = {};
  for (const f of TX_CORE_FIELDS) core[f] = tx[f];
  return core;
}

router.post('/sync', auth, async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions)) {
    return res.status(400).json({ error: 'transactions must be an array' });
  }

  const results = [];

  for (const tx of transactions) {
    const result = { id: tx.id };

    const wellFormed =
      tx.id &&
      tx.senderId &&
      tx.receiverId &&
      typeof tx.amount === 'number' &&
      tx.amount > 0 &&
      tx.timestamp &&
      tx.senderPublicKey &&
      tx.senderSignature;

    if (!wellFormed) {
      result.status = 'rejected';
      result.reason = 'MALFORMED_TRANSACTION';
      results.push(result);
      continue;
    }

    const sender = await db.getUserById(tx.senderId);
    const receiver = await db.getUserById(tx.receiverId);
    if (!sender || !receiver) {
      result.status = 'rejected';
      result.reason = 'UNKNOWN_PARTICIPANT';
      results.push(result);
      continue;
    }

    const senderSigValid = verifySignature(corePayload(tx), tx.senderSignature, tx.senderPublicKey);
    if (!senderSigValid) {
      result.status = 'rejected';
      result.reason = 'INVALID_SENDER_SIGNATURE';
      results.push(result);
      continue;
    }

    if (tx.senderPublicKey !== sender.publicKey) {
      result.status = 'rejected';
      result.reason = 'SENDER_KEY_MISMATCH';
      results.push(result);
      continue;
    }

    let receiverSigValid = false;
    if (tx.receiverSignature && tx.receiverPublicKey) {
      receiverSigValid = verifySignature(
        { ...corePayload(tx), ack: true },
        tx.receiverSignature,
        tx.receiverPublicKey
      );
    }

    const existing = await db.getTransaction(tx.id);
    if (existing) {
      const merged = { ...existing };
      if (receiverSigValid && !existing.receiverSignature) {
        merged.receiverSignature = tx.receiverSignature;
        merged.receiverPublicKey = tx.receiverPublicKey;
      }
      merged.syncedBy = Array.from(new Set([...(existing.syncedBy || []), req.userId]));
      await db.upsertTransaction(merged);
      result.status = merged.status;
      result.reason = merged.reason || null;
      results.push(result);
      continue;
    }

    await db.upsertTransaction({
      id: tx.id,
      senderId: tx.senderId,
      receiverId: tx.receiverId,
      amount: tx.amount,
      timestamp: tx.timestamp,
      senderPublicKey: tx.senderPublicKey,
      senderSignature: tx.senderSignature,
      receiverPublicKey: receiverSigValid ? tx.receiverPublicKey : null,
      receiverSignature: receiverSigValid ? tx.receiverSignature : null,
      status: 'pending',
      applied: false,
      syncedBy: [req.userId]
    });
    result.status = 'pending';
    results.push(result);
  }

  const senderIds = new Set(transactions.map((t) => t.senderId).filter(Boolean));
  for (const senderId of senderIds) {
    const sender = await db.getUserById(senderId);
    if (!sender) continue;

    const pending = await db.getPendingOutgoing(senderId);
    const startingBalance = sender.walletBalance;
    let runningTotal = 0;
    let overLimit = false;

    for (const tx of pending) {
      runningTotal += tx.amount;

      if (!overLimit && runningTotal <= startingBalance) {
        if (!tx.applied) {
          await db.upsertTransaction({ id: tx.id, status: 'confirmed', applied: true });
          const currentSender = await db.getUserById(tx.senderId);
          const currentReceiver = await db.getUserById(tx.receiverId);
          await db.updateUser(tx.senderId, { walletBalance: currentSender.walletBalance - tx.amount });
          await db.updateUser(tx.receiverId, { walletBalance: currentReceiver.walletBalance + tx.amount });
        }
      } else {
        overLimit = true;
        if (!tx.applied) {
          await db.upsertTransaction({
            id: tx.id,
            status: 'rejected',
            reason: 'EXCEEDS_AVAILABLE_BALANCE',
            applied: true
          });
          await db.updateUser(senderId, { accountFlagged: true });
        }
      }
    }
  }

  const finalResults = [];
  for (const r of results) {
    const tx = await db.getTransaction(r.id);
    finalResults.push(tx ? { id: r.id, status: tx.status, reason: tx.reason || null } : r);
  }

  const me = await db.getUserById(req.userId);
  res.json({ results: finalResults, balance: me.walletBalance, accountFlagged: me.accountFlagged });
});

module.exports = router;
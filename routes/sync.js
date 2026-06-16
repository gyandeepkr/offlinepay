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

// This is the safety net behind the on-device ₹500 offline cap. Any device
// can call this whenever it regains internet access. It:
//   1. Verifies every transaction's signature so a tampered/forged
//      transaction can never be applied.
//   2. Confirms transactions against the sender's REAL balance, oldest
//      first, so honest transactions get settled even if something else in
//      the batch is bad.
//   3. Rejects (and flags the account for) anything that would push the
//      sender below zero -- this is what catches a double-spend, e.g. the
//      same account spending its ₹500 offline allowance on two devices
//      before either had a chance to sync.
router.post('/sync', auth, (req, res) => {
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

    const sender = db.getUserById(tx.senderId);
    const receiver = db.getUserById(tx.receiverId);
    if (!sender || !receiver) {
      result.status = 'rejected';
      result.reason = 'UNKNOWN_PARTICIPANT';
      results.push(result);
      continue;
    }

    // Was this really signed by the sender's private key?
    const senderSigValid = verifySignature(corePayload(tx), tx.senderSignature, tx.senderPublicKey);
    if (!senderSigValid) {
      result.status = 'rejected';
      result.reason = 'INVALID_SENDER_SIGNATURE';
      results.push(result);
      continue;
    }

    // Does the key used for signing actually belong to the claimed sender?
    if (tx.senderPublicKey !== sender.publicKey) {
      result.status = 'rejected';
      result.reason = 'SENDER_KEY_MISMATCH';
      results.push(result);
      continue;
    }

    // Receiver's acknowledgement is optional (the receiver might sync this
    // transaction independently before the sender does).
    let receiverSigValid = false;
    if (tx.receiverSignature && tx.receiverPublicKey) {
      receiverSigValid = verifySignature(
        { ...corePayload(tx), ack: true },
        tx.receiverSignature,
        tx.receiverPublicKey
      );
    }

    const existing = db.getTransaction(tx.id);
    if (existing) {
      // Already seen (e.g. the other party synced it first). Just merge in
      // the receiver's ack if it's new -- never re-apply balance changes.
      const merged = { ...existing };
      if (receiverSigValid && !existing.receiverSignature) {
        merged.receiverSignature = tx.receiverSignature;
        merged.receiverPublicKey = tx.receiverPublicKey;
      }
      merged.syncedBy = Array.from(new Set([...(existing.syncedBy || []), req.userId]));
      db.upsertTransaction(merged);
      result.status = merged.status;
      result.reason = merged.reason || null;
      results.push(result);
      continue;
    }

    // Brand new transaction -- store as "pending" and let the reconciliation
    // pass below decide whether it can be honored.
    db.upsertTransaction({
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

  // ---- Reconciliation ----
  // For every sender touched by this batch, walk their still-pending
  // outgoing transactions oldest-first. Confirm them while the running
  // total stays within their real wallet balance; reject everything after
  // that point as exceeding what they actually had.
  const senderIds = new Set(transactions.map((t) => t.senderId).filter(Boolean));
  for (const senderId of senderIds) {
    const sender = db.getUserById(senderId);
    if (!sender) continue;

    const pending = db.getPendingOutgoing(senderId);
    const startingBalance = sender.walletBalance;
    let runningTotal = 0;
    let overLimit = false;

    for (const tx of pending) {
      runningTotal += tx.amount;

      if (!overLimit && runningTotal <= startingBalance) {
        if (!tx.applied) {
          db.upsertTransaction({ id: tx.id, status: 'confirmed', applied: true });
          const currentSender = db.getUserById(tx.senderId);
          const currentReceiver = db.getUserById(tx.receiverId);
          db.updateUser(tx.senderId, { walletBalance: currentSender.walletBalance - tx.amount });
          db.updateUser(tx.receiverId, { walletBalance: currentReceiver.walletBalance + tx.amount });
        }
      } else {
        overLimit = true;
        if (!tx.applied) {
          db.upsertTransaction({
            id: tx.id,
            status: 'rejected',
            reason: 'EXCEEDS_AVAILABLE_BALANCE',
            applied: true
          });
          db.updateUser(senderId, { accountFlagged: true });
        }
      }
    }
  }

  const finalResults = results.map((r) => {
    const tx = db.getTransaction(r.id);
    return tx ? { id: r.id, status: tx.status, reason: tx.reason || null } : r;
  });

  const me = db.getUserById(req.userId);
  res.json({ results: finalResults, balance: me.walletBalance, accountFlagged: me.accountFlagged });
});

module.exports = router;

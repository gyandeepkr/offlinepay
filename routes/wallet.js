const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/balance', auth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ balance: user.walletBalance, accountFlagged: user.accountFlagged });
});

// Simulated bank top-up. In production this would be a payment gateway
// webhook (Razorpay/Cashfree/etc.) that credits the wallet after a real
// bank transfer is confirmed.
router.post('/topup', auth, (req, res) => {
  const { amount } = req.body;
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const user = db.getUserById(req.userId);
  const newBalance = user.walletBalance + amount;
  db.updateUser(req.userId, { walletBalance: newBalance });
  res.json({ balance: newBalance });
});

// Used during BLE pairing to confirm a receiver's identity/public key.
router.get('/users/:email/publickey', auth, (req, res) => {
  const user = db.getUserByEmail(req.params.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, publicKey: user.publicKey });
});

module.exports = router;

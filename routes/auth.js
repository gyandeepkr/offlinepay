const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// The mobile app generates an Ed25519 key pair on-device and sends only the
// PUBLIC key here. The private key never leaves the device. This public key
// is what we use later to verify signatures on offline transactions.
router.post('/register', async (req, res) => {
  const { email, password, name, publicKey } = req.body;

  if (!email || !password || !name || !publicKey) {
    return res.status(400).json({ error: 'email, password, name, and publicKey are required' });
  }
  if (await db.getUserByEmail(email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    email,
    passwordHash,
    name,
    publicKey,
    walletBalance: 0,
    accountFlagged: false,
    createdAt: Date.now()
  };
  await db.createUser(user);

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.getUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    publicKey: user.publicKey,
    walletBalance: user.walletBalance,
    accountFlagged: user.accountFlagged
  };
}

module.exports = router;

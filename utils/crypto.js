const nacl = require('tweetnacl');
const { decodeBase64, decodeUTF8 } = require('tweetnacl-util');

// Deterministic JSON serialization -- the mobile app's cryptoService.js must
// produce byte-for-byte identical output for the same object, otherwise
// signature verification will fail.
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function verifySignature(payload, signatureBase64, publicKeyBase64) {
  try {
    const message = decodeUTF8(canonicalize(payload));
    const signature = decodeBase64(signatureBase64);
    const publicKey = decodeBase64(publicKeyBase64);
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch (e) {
    return false;
  }
}

module.exports = { canonicalize, verifySignature };

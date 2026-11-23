'use strict';
// Proves a Solana wallet signed our message (Phantom / Solflare "signMessage").
// Solana addresses are base58 ed25519 public keys; Node can verify ed25519 natively.
const crypto = require('crypto');

const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHA].map((c, i) => [c, i]));

function b58decode(s) {
  if (!s || /[^1-9A-HJ-NP-Za-km-z]/.test(s)) return null;
  const bytes = [0];
  for (const ch of s) {
    let carry = MAP[ch];
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === '1') bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}

// sig may be base58 or base64; wallet is the base58 address.
function verifyWallet(wallet, message, sig) {
  try {
    const pub = b58decode(wallet);
    if (!pub || pub.length !== 32) return false;
    let s = b58decode(sig);
    if (!s || s.length !== 64) s = Buffer.from(sig, 'base64');
    if (s.length !== 64) return false;
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, s);
  } catch (_) {
    return false;
  }
}

module.exports = { verifyWallet, b58decode };

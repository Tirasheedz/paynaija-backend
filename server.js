// PayNaija Backend - ALL IN ONE FILE - Copy this ONE file only
// Run: npm install express mysql2 dotenv cors bcryptjs jsonwebtoken axios
// Then: node server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const app = express();
app.use(cors()); app.use(express.json());

// ===== CONFIG (Edit here, no .env needed) =====
const DB = { host: 'localhost', user: 'root', password: '', database: 'paynaija' };
const JWT_SECRET = 'paynaija_super_secret_123';
const FLW_SECRET = 'FLWSECK_TEST-xxx';
const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 10 });
pool.getConnection().then(c => { console.log('✅ MySQL Connected'); c.release(); }).catch(e => console.log('❌ MySQL Error:', e.message));

// ===== AUTH MIDDLEWARE =====
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); } catch { return res.status(401).json({ error: 'Invalid token' }); }
};
const genRef = (p) => p + '-' + Date.now() + '-' + Math.floor(Math.random()*1000);

// ===== 1. REGISTER =====
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password, bvn } = req.body;
    if (!name || !email || !phone || !password) return res.status(400).json({ error: 'Fill all fields' });
    const [exists] = await pool.query('SELECT id FROM users WHERE email=? OR phone=?', [email, phone]);
    if (exists.length) return res.status(400).json({ error: 'User already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const [r] = await pool.query('INSERT INTO users (name,email,phone,password,bvn) VALUES (?,?,?,?,?)', [name, email, phone, hashed, bvn || null]);
    const user_id = r.insertId;
    await pool.query('INSERT INTO usdt_wallets (user_id, usdt_balance, trc20_address) VALUES (?,?,?)', [user_id, 0, 'TQn9Y2khDD95J1B8k' + user_id + '9KxQ']);
    const cardNum = '5399' + String(Math.floor(100000000000 + Math.random()*899999999999)).slice(0,12);
    await pool.query('INSERT INTO virtual_cards (user_id, card_number, card_holder, expiry, cvv, balance) VALUES (?,?,?,?,?,?)', [user_id, cardNum, name.toUpperCase(), '12/28', '482', 0]);
    const token = jwt.sign({ id: user_id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user_id, name, email, phone } });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ===== 2. LOGIN =====
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE email=?', [email]);
    if (!rows.length) return res.status(400).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, rows[0].password);
    if (!ok) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: rows[0].id, name: rows[0].name, email, phone: rows[0].phone } });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ===== 3. CREATE VIRTUAL ACCOUNT =====
app.post('/api/account/create-virtual', auth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const [u] = await pool.query('SELECT * FROM users WHERE id=?', [user_id]);
    const [existing] = await pool.query('SELECT * FROM virtual_accounts WHERE user_id=?', [user_id]);
    if (existing.length) return res.json({ success: true, account: existing[0] });
    const account_number = '80' + String(Math.floor(10000000 + Math.random()*89999999));
    const bank_name = 'Providus Bank'; const account_name = `${u[0].name} - PayNaija`;
    await pool.query('INSERT INTO virtual_accounts (user_id, account_number, bank_name, account_name, balance) VALUES (?,?,?,?,?)', [user_id, account_number, bank_name, account_name, 50000]);
    res.json({ success: true, account: { account_number, bank_name, account_name, balance: 50000 } });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ===== 4. DASHBOARD =====
app.get('/api/dashboard', auth, async (req, res) => {
  const user_id = req.user.id;
  const [acc] = await pool.query('SELECT * FROM virtual_accounts WHERE user_id=?', [user_id]);
  const [usdt] = await pool.query('SELECT * FROM usdt_wallets WHERE user_id=?', [user_id]);
  const [card] = await pool.query('SELECT * FROM virtual_cards WHERE user_id=?', [user_id]);
  const [txs] = await pool.query('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20', [user_id]);
  res.json({ success: true, account: acc[0] || null, usdt: usdt[0] || null, card: card[0] || null, transactions: txs });
});

// ===== 5. SEND MONEY =====
app.post('/api/send-money', auth, async (req, res) => {
  try {
    const { recipient_account, recipient_name, amount } = req.body; const amt = Number(amount); const user_id = req.user.id;
    const [acc] = await pool.query('SELECT * FROM virtual_accounts WHERE user_id=?', [user_id]);
    if (!acc.length || acc[0].balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
    await pool.query('UPDATE virtual_accounts SET balance = balance - ? WHERE user_id=?', [amt, user_id]);
    const ref = genRef('SEND');
    await pool.query('INSERT INTO transactions (user_id, type, amount, recipient, reference, description) VALUES (?,?,?,?,?,?)', [user_id, 'SEND', amt, recipient_name || recipient_account, ref, `Sent to ${recipient_account}`]);
    res.json({ success: true, message: `₦${amt.toLocaleString()} sent`, reference: ref });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ===== 6. USDT SWAP =====
app.post('/api/usdt/swap', auth, async (req, res) => {
  try {
    const { usdt_amount } = req.body; const usdtAmt = Number(usdt_amount); const user_id = req.user.id;
    const rate = 1563; const fee = 1200; const naira = usdtAmt * rate - fee;
    const [w] = await pool.query('SELECT * FROM usdt_wallets WHERE user_id=?', [user_id]);
    if (!w.length || w[0].usdt_balance < usdtAmt) return res.status(400).json({ error: 'Not enough USDT' });
    await pool.query('UPDATE usdt_wallets SET usdt_balance = usdt_balance - ? WHERE user_id=?', [usdtAmt, user_id]);
    await pool.query('UPDATE virtual_accounts SET balance = balance + ? WHERE user_id=?', [naira, user_id]);
    await pool.query('INSERT INTO transactions (user_id, type, amount, reference, description) VALUES (?,?,?,?,?)', [user_id, 'USDT_SWAP', naira, genRef('SWAP'), `${usdtAmt} USDT → ₦${naira}`]);
    res.json({ success: true, naira_received: naira, rate });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ===== 7. VIRTUAL CARD =====
app.get('/api/card', auth, async (req, res) => { const [r] = await pool.query('SELECT * FROM virtual_cards WHERE user_id=?', [req.user.id]); res.json({ success: true, card: r[0] }); });
app.post('/api/card/fund', auth, async (req, res) => {
  const amt = Number(req.body.amount); const user_id = req.user.id;
  const [acc] = await pool.query('SELECT * FROM virtual_accounts WHERE user_id=?', [user_id]);
  if (acc[0].balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
  await pool.query('UPDATE virtual_accounts SET balance = balance - ? WHERE user_id=?', [amt, user_id]);
  await pool.query('UPDATE virtual_cards SET balance = balance + ? WHERE user_id=?', [amt, user_id]);
  res.json({ success: true, message: `Card funded ₦${amt}` });
});
app.post('/api/card/freeze', auth, async (req, res) => { await pool.query('UPDATE virtual_cards SET is_frozen=? WHERE user_id=?', [req.body.freeze ? 1 : 0, req.user.id]); res.json({ success: true }); });

// ===== 8. BILLS =====
app.post('/api/bills/pay', auth, async (req, res) => {
  const { bill_type, provider, amount, phone_or_meter } = req.body; const amt = Number(amount); const user_id = req.user.id;
  const [acc] = await pool.query('SELECT * FROM virtual_accounts WHERE user_id=?', [user_id]);
  if (acc[0].balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
  await pool.query('UPDATE virtual_accounts SET balance = balance - ? WHERE user_id=?', [amt, user_id]);
  await pool.query('INSERT INTO bills (user_id, bill_type, provider, amount, phone_or_meter) VALUES (?,?,?,?,?)', [user_id, bill_type, provider, amt, phone_or_meter]);
  res.json({ success: true, message: `${bill_type} paid` });
});

// ===== 9. TRANSACTIONS =====
app.get('/api/transactions', auth, async (req, res) => { const [r] = await pool.query('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]); res.json({ success: true, transactions: r }); });

// ===== 10. WEBHOOK (Auto-credit) =====
app.post('/api/webhook/flutterwave', async (req, res) => {
  try {
    const p = req.body;
    if (p.event === 'charge.completed') {
      const { account_number, amount } = p.data;
      const [acc] = await pool.query('SELECT * FROM virtual_accounts WHERE account_number=?', [account_number]);
      if (acc.length) {
        await pool.query('UPDATE virtual_accounts SET balance = balance + ? WHERE account_number=?', [amount, account_number]);
        await pool.query('INSERT INTO transactions (user_id, type, amount, reference, description) VALUES (?,?,?,?,?)', [acc[0].user_id, 'RECEIVE', amount, p.data.tx_ref || genRef('RCV'), 'Bank transfer received']);
      }
    }
    res.json({ ok: true });
  } catch(e){ res.json({ ok: true }); }
});

app.get('/', (req, res) => res.json({ message: 'PayNaija Backend Running 🚀' }));
app.listen(3000, () => console.log('🚀 Running on http://localhost:3000'));

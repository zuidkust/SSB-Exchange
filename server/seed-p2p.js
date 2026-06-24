// Seed P2P test data — inserts orders and active loans for UI testing
// Run: node server/seed-p2p.js
// First activates all 11 player accounts, then inserts P2P test data
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB = path.join(__dirname, '..', 'data', 'ssb.sqlite');
const db = new DatabaseSync(DB);

function q(v) { return `'${String(v).replace(/'/g, "''")}'`; }
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

// Step 1: Clean up old seed data
db.exec('DELETE FROM p2p_orders;');
db.exec('DELETE FROM p2p_loans;');
db.exec('UPDATE users SET has_p2p_loan = 0, p2p_role = NULL;');

// Step 2: Activate all 11 player accounts (set password and activated_at)
const crypto = require('node:crypto');
const PLAYERS = [
  'DEMO01', 'DEMO02', 'DEMO03', 'DEMO04', 'DEMO05',
  'DEMO06', 'DEMO07', 'DEMO08', 'DEMO09', 'DEMO10', 'DEMO11'
];
const pwdSalt = crypto.randomBytes(16).toString('hex');
const pwdHash = crypto.scryptSync('123456', pwdSalt, 64).toString('hex');

for (const username of PLAYERS) {
  db.exec(`UPDATE users SET
    password_hash = ${q(pwdHash)}, password_salt = ${q(pwdSalt)},
    activated_at = ${q(now)}, updated_at = datetime('now')
    WHERE username = ${q(username)};`);
}

// Step 3: Fetch all user UUIDs
const userMap = Object.fromEntries(
  db.prepare('SELECT id, username FROM users WHERE is_admin = 0;').all()
    .map(r => [r.username, r.id])
);
console.log('Activated users:', Object.keys(userMap).join(', '));

const m = userMap;
function uid(u) { return m[u] || u; }

// Step 4: Insert active P2P loans (matched & in-progress)
// Group 1: DEMO01 lends 50k to DEMO02 @ 中低息(0.8%) × 24 ticks
db.exec(`INSERT INTO p2p_loans (lender_id, borrower_id, principal, rate_tier, rate_per_tick, term_ticks, accrued_interest, start_tick, deadline_tick, status, created_at, updated_at)
  VALUES (${q(uid('DEMO01'))}, ${q(uid('DEMO02'))}, 50000, 2, 0.008, 24, 3200, 5, 29, 'active', ${q(now)}, ${q(now)});`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'lender' WHERE id = ${q(uid('DEMO01'))};`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'borrower' WHERE id = ${q(uid('DEMO02'))};`);

// Group 2: DEMO05 lends 80k to DEMO09 @ 高息(1.6%) × 16 ticks
db.exec(`INSERT INTO p2p_loans (lender_id, borrower_id, principal, rate_tier, rate_per_tick, term_ticks, accrued_interest, start_tick, deadline_tick, status, created_at, updated_at)
  VALUES (${q(uid('DEMO05'))}, ${q(uid('DEMO09'))}, 80000, 4, 0.016, 16, 5120, 3, 19, 'active', ${q(now)}, ${q(now)});`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'lender' WHERE id = ${q(uid('DEMO05'))};`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'borrower' WHERE id = ${q(uid('DEMO09'))};`);

// Group 3: DEMO04 lends 120k to DEMO08 @ 中高息(1.2%) × 32 ticks
db.exec(`INSERT INTO p2p_loans (lender_id, borrower_id, principal, rate_tier, rate_per_tick, term_ticks, accrued_interest, start_tick, deadline_tick, status, created_at, updated_at)
  VALUES (${q(uid('DEMO04'))}, ${q(uid('DEMO08'))}, 120000, 3, 0.012, 32, 8640, 2, 34, 'active', ${q(now)}, ${q(now)});`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'lender' WHERE id = ${q(uid('DEMO04'))};`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'borrower' WHERE id = ${q(uid('DEMO08'))};`);

// Group 4: DEMO06 lends 30k to DEMO07 @ 低息(0.4%) × 40 ticks
db.exec(`INSERT INTO p2p_loans (lender_id, borrower_id, principal, rate_tier, rate_per_tick, term_ticks, accrued_interest, start_tick, deadline_tick, status, created_at, updated_at)
  VALUES (${q(uid('DEMO06'))}, ${q(uid('DEMO07'))}, 30000, 1, 0.004, 40, 1600, 4, 44, 'active', ${q(now)}, ${q(now)});`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'lender' WHERE id = ${q(uid('DEMO06'))};`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'borrower' WHERE id = ${q(uid('DEMO07'))};`);

// Group 5: DEMO10 lends 200k to DEMO01 @ 高息(1.6%) × 16 ticks (near deadline — urgent)
db.exec(`INSERT INTO p2p_loans (lender_id, borrower_id, principal, rate_tier, rate_per_tick, term_ticks, accrued_interest, start_tick, deadline_tick, status, created_at, updated_at)
  VALUES (${q(uid('DEMO10'))}, ${q(uid('DEMO01'))}, 200000, 4, 0.016, 16, 19200, 1, 17, 'active', ${q(now)}, ${q(now)});`);
db.exec(`UPDATE users SET has_p2p_loan = 1, p2p_role = 'lender' WHERE id = ${q(uid('DEMO10'))};`);

// Step 5: Insert open orders (waiting for match)
const orders = [
  [uid('DEMO10'), 'lend', 60000, 2, 24, 60000 * 0.008 * 24],
  [uid('DEMO03'), 'borrow', 100000, 3, 32, 100000 * 0.012 * 32],
  [uid('DEMO07'), 'borrow', 150000, 4, 16, 150000 * 0.016 * 16],
  [uid('DEMO02'), 'lend', 40000, 1, 40, 40000 * 0.004 * 40],
  [uid('DEMO03'), 'borrow', 25000, 1, 24, 25000 * 0.004 * 24],
  [uid('DEMO11'), 'lend', 90000, 3, 32, 90000 * 0.012 * 32],
];

for (const [userId, direction, amount, rateTier, termTicks, expected] of orders) {
  db.exec(`INSERT INTO p2p_orders
    (user_id, direction, amount, rate_tier, term_ticks, expected_return, status, created_at, updated_at)
    VALUES (${q(userId)}, ${q(direction)}, ${amount}, ${rateTier}, ${termTicks}, ${expected}, 'open', ${q(now)}, ${q(now)});`);
}

console.log('P2P seed data ready:');
console.log('  11 players activated with test passwords');
console.log('  5 active P2P loans (matched, in-progress)');
console.log('  6 open orders (3 lend + 3 borrow)');
console.log('');
console.log('Active loans:');
console.log('  DEMO10 → DEMO01  200k  高息(1.6%) 16tick  (near deadline)');
console.log('  DEMO04 → DEMO08  120k  中高息(1.2%) 32tick');
console.log('  DEMO05 → DEMO09   80k  高息(1.6%) 16tick');
console.log('  DEMO01 → DEMO02   50k  中低息(0.8%) 24tick  (accrued 3200)');
console.log('  DEMO06 → DEMO07   30k  低息(0.4%) 40tick  (accrued 1600)');
console.log('');
console.log('Open orders:');
console.log('  [借] DEMO03  100k 中高息 32tick');
console.log('  [借] DEMO07  150k 高息 16tick');
console.log('  [借] DEMO03   25k 低息 24tick');
console.log('  [出] DEMO10   60k 中低息 24tick');
console.log('  [出] DEMO02   40k 低息 40tick');
console.log('  [出] DEMO11   90k 中高息 32tick');
db.close();

const ADMIN_ACCOUNT = {
  code: 'SSB-DEMO',
  nickname: '运营',
  is_admin: true,
  passwordless: true
};

function normalizeAccountCode(code) {
  return String(code || '').replace(/[\s-]/g, '').trim().toUpperCase();
}

function findAccount(code) {
  const normalized = normalizeAccountCode(code);
  if (normalized === ADMIN_ACCOUNT.code) return ADMIN_ACCOUNT;
  return null;
}

module.exports = { ADMIN_ACCOUNT, findAccount, normalizeAccountCode };

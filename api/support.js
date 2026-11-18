module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const phone = (process.env.LESGO_SUPPORT_WHATSAPP || '').replace(/[\s()+-]/g, '').replace(/^0/, '62');
  return res.status(200).json({ whatsapp: /^628\d{8,12}$/.test(phone) ? phone : '' });
};

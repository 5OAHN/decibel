const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'server_configuration_error',
      message: '서버 설정 오류입니다. ANTHROPIC_API_KEY를 확인해주세요.',
    });
  }

  const { prompt, type } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'prompt가 필요합니다.' });
  }

  // PDF 파싱 타입 포함
  const allowedTypes = ['metrics', 'resume', 'parse'];
  if (type && !allowedTypes.includes(type)) {
    return res.status(400).json({ error: 'bad_request', message: '유효하지 않은 요청 타입입니다.' });
  }

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (response.status === 429) {
      return res.status(429).json({
        error: 'exceeded_limit',
        message: 'AI 사용량이 폭주하여 일시적으로 제한되었습니다. 잠시 후 시도해주세요.',
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.type || 'api_error',
        message: data?.error?.message || 'API 오류가 발생했습니다.',
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('[Decibel] 서버 오류:', err);
    return res.status(500).json({
      error: 'internal_server_error',
      message: '일시적인 서버 오류입니다. 잠시 후 다시 시도해주세요.',
    });
  }
};

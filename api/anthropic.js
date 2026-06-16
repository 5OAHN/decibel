/**
 * api/anthropic.js
 * Vercel Serverless Function — Anthropic API Proxy
 *
 * 역할: 클라이언트의 프롬프트를 받아 Anthropic API를 호출하고 결과를 반환.
 * API Key는 Vercel 환경변수 ANTHROPIC_API_KEY 에서 읽어옴.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;

export default async function handler(req, res) {
  // ── CORS 헤더 (로컬 개발 환경 대응) ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight 요청 처리
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // POST 이외 메서드 차단
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // API Key 존재 확인
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[CareerCraft] ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    return res.status(500).json({
      error: 'server_configuration_error',
      message: '서버 설정 오류입니다. 관리자에게 문의해주세요.',
    });
  }

  // 요청 바디 파싱
  const { prompt, type } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({
      error: 'bad_request',
      message: 'prompt 필드가 필요합니다.',
    });
  }

  // type 화이트리스트 검증 (metrics | resume)
  const allowedTypes = ['metrics', 'resume'];
  if (type && !allowedTypes.includes(type)) {
    return res.status(400).json({
      error: 'bad_request',
      message: '유효하지 않은 요청 타입입니다.',
    });
  }

  try {
    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await anthropicRes.json();

    // ── Rate Limit (429) 처리 ──
    if (anthropicRes.status === 429) {
      console.warn('[CareerCraft] Anthropic API Rate Limit 도달:', data);
      return res.status(429).json({
        error: 'exceeded_limit',
        message: 'AI 사용량이 폭주하여 일시적으로 제한되었습니다. 잠시 후 시도해주세요.',
      });
    }

    // ── 기타 Anthropic API 에러 처리 ──
    if (!anthropicRes.ok) {
      const errType = data?.error?.type || 'api_error';
      const errMsg  = data?.error?.message || 'Anthropic API 오류가 발생했습니다.';
      console.error(`[CareerCraft] Anthropic API 에러 (${anthropicRes.status}):`, errMsg);
      return res.status(anthropicRes.status).json({
        error: errType,
        message: errMsg,
      });
    }

    // ── 정상 응답 반환 ──
    return res.status(200).json(data);

  } catch (err) {
    // 네트워크 오류 등 예상치 못한 에러
    console.error('[CareerCraft] 서버 내부 오류:', err);
    return res.status(500).json({
      error: 'internal_server_error',
      message: '일시적인 서버 오류입니다. 잠시 후 다시 시도해주세요.',
    });
  }
}

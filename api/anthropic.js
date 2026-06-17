/**
 * api/anthropic.js
 * Vercel Serverless Function — Anthropic API Proxy
 *
 * 하이브리드 모델 라우팅:
 *   빠른 작업 (parse, link_parse, interview) → claude-haiku-3-20240307
 *   고품질 작업 (metrics, resume)            → claude-3-5-sonnet-20240620
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const JINA_BASE_URL     = 'https://r.jina.ai/';

// 하이브리드 모델 라우팅 테이블
const MODEL_MAP = {
  parse:      'claude-haiku-3-20240307',
  link_parse: 'claude-haiku-3-20240307',
  interview:  'claude-haiku-3-20240307',
  metrics:    'claude-3-5-sonnet-20240620',
  resume:     'claude-3-5-sonnet-20240620',
};
const DEFAULT_MODEL = 'claude-haiku-3-20240307';

const ALLOWED_TYPES = ['parse', 'link_parse', 'interview', 'metrics', 'resume'];

module.exports = async function handler(req, res) {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method Not Allowed' });

  // ── API Key 확인 ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[데시벨] ANTHROPIC_API_KEY 미설정');
    return res.status(500).json({
      error: 'server_configuration_error',
      message: '서버 설정 오류입니다. 관리자에게 문의해주세요.',
    });
  }

  const { prompt, type, url } = req.body || {};

  // ── type 검증 ──
  if (!type || !ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: 'bad_request', message: '유효하지 않은 요청 타입입니다.' });
  }

  try {
    // ══════════════════════════════════════════════════
    // link_parse: Jina Reader 스크래핑 → Claude 분석
    // ══════════════════════════════════════════════════
    if (type === 'link_parse') {
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        return res.status(400).json({
          error: 'bad_request',
          message: '유효한 URL을 입력해주세요.',
        });
      }

      // 1. Jina Reader로 마크다운 추출
      let scrapedText = '';
      try {
        const jinaRes = await fetch(`${JINA_BASE_URL}${encodeURIComponent(url)}`, {
          headers: {
            'Accept': 'text/markdown',
            'X-Return-Format': 'markdown',
          },
          signal: AbortSignal.timeout(15000), // 15초 타임아웃
        });

        if (jinaRes.ok) {
          scrapedText = await jinaRes.text();
        }
      } catch (jinaErr) {
        console.error('[데시벨] Jina Reader 오류:', jinaErr.message);
      }

      // 2. 추출 실패 or 내용 너무 짧으면 에러
      if (!scrapedText || scrapedText.trim().length < 50) {
        return res.status(400).json({
          error: 'scrape_failed',
          message: "비공개 링크거나 접근할 수 없어요. '웹에서 공유'가 켜져 있는지 확인해 주세요!",
        });
      }

      // 3. 8,000자 제한 (토큰 비용 최적화)
      const excerpt = scrapedText.trim().slice(0, 8000);

      // 4. Claude 분석 프롬프트 (백엔드에서 직접 구성)
      const linkPrompt = `아래는 포트폴리오 웹페이지에서 추출한 마크다운 텍스트입니다.
이 내용을 분석하여 가장 대표적인 프로젝트 1개의 정보를 JSON으로 추출해주세요.
텍스트에서 명확히 파악되는 정보만 추출하고, 불확실한 항목은 빈 문자열("")로 두세요.

[추출 텍스트]
${excerpt}

다음 JSON 형식으로만 응답하세요 (코드블록 없이 순수 JSON):
{
  "projectName": "프로젝트명 (없으면 빈 문자열)",
  "companyName": "회사/조직명 (없으면 빈 문자열)",
  "startDate": "YYYY.MM 형식 시작일 (없으면 빈 문자열)",
  "endDate": "YYYY.MM 형식 종료일 (없으면 빈 문자열)",
  "position": "직무 포지션 (기획자/PM, UI/UX 디자이너, 프론트엔드 개발자, 백엔드 개발자, 풀스택 개발자, 데이터 분석가, 마케터, 기타 중 하나, 없으면 빈 문자열)",
  "tools": ["사용 툴/기술 목록 (없으면 빈 배열)"],
  "workContent": "주요 업무 내용 요약 (bullet point 형식, 200자 이내, 없으면 빈 문자열)"
}`;

      // 5. Claude 호출 (haiku — 빠른 구조화 작업)
      return await callAnthropic(apiKey, 'claude-haiku-3-20240307', linkPrompt, 1000, res);
    }

    // ══════════════════════════════════════════════════
    // 일반 타입: prompt 필수 검증 후 Claude 호출
    // ══════════════════════════════════════════════════
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'bad_request', message: 'prompt가 필요합니다.' });
    }

    const model     = MODEL_MAP[type] || DEFAULT_MODEL;
    const maxTokens = (type === 'metrics' || type === 'resume') ? 1500 : 1000;

    return await callAnthropic(apiKey, model, prompt, maxTokens, res);

  } catch (err) {
    console.error('[데시벨] 서버 내부 오류:', err);
    return res.status(500).json({
      error: 'internal_server_error',
      message: '일시적인 서버 오류입니다. 잠시 후 다시 시도해주세요.',
    });
  }
};

/**
 * Anthropic API 호출 공통 함수
 */
async function callAnthropic(apiKey, model, prompt, maxTokens, res) {
  const anthropicRes = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await anthropicRes.json();

  // Rate Limit
  if (anthropicRes.status === 429) {
    console.warn('[데시벨] Rate Limit 도달');
    return res.status(429).json({
      error: 'exceeded_limit',
      message: 'AI 사용량이 폭주하여 일시적으로 제한되었습니다. 잠시 후 시도해주세요.',
    });
  }

  // 기타 Anthropic 에러
  if (!anthropicRes.ok) {
    console.error(`[데시벨] Anthropic 에러 (${anthropicRes.status}):`, data?.error?.message);
    return res.status(anthropicRes.status).json({
      error: data?.error?.type || 'api_error',
      message: data?.error?.message || 'AI 처리 중 오류가 발생했습니다.',
    });
  }

  return res.status(200).json(data);
}

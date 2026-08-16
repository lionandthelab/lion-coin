'use strict';

// 캔들 차트 SVG 생성 — 순수 함수. 외부 차트 라이브러리를 쓰지 않는다.
//
// 목적은 예쁜 그림이 아니라 **"왜 잡혔는지"를 눈으로 확인하는 것**이다.
// 그래서 세 가지가 한 화면에 있어야 한다:
//   1. 돌파선 — 직전 N봉의 고가. 이 선을 넘은 것이 신호의 출발점이다
//   2. 돌파한 봉 — 강조해서 어느 봉이 신호를 만들었는지 즉시 보이게
//   3. 거래량 막대와 평균선 — 거래량이 평소와 얼마나 다른지가 진짜 돌파의 근거다
// 셋 중 하나라도 빠지면 그림에서 판단 근거가 사라진다.

const WIDTH = 720;
const PRICE_H = 200;
const VOL_H = 60;
const PAD = 8;

// 값→y 좌표. 최고가가 위(작은 y)로 간다.
// 평평한 구간(min===max)에서 0으로 나누면 좌표가 NaN이 되고, SVG는 조용히
// 아무것도 그리지 않는다 — "데이터가 없는 것"과 구분되지 않아 가장 나쁘다.
function scaleY({ min, max, top, height }) {
  const span = max - min;
  if (!(span > 0)) return () => top + height / 2;
  return (v) => top + (1 - (v - min) / span) * height;
}

// 가격 표기는 자릿수에 맞춰야 한다. 9원대 코인을 정수로 반올림하면 돌파선·익절·
// 손절이 전부 "9"로 뭉개져 그림에서 판단 근거가 사라진다 (실제 렌더에서 발견).
function formatPrice(v) {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : abs >= 1 ? 3 : 6;
  return v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function candleChart(candles, {
  breakoutLevel = null,
  takeProfit = null,
  stopLoss = null,
  highlightLast = false,
  showVolume = false,
  label = '',
} = {}) {
  if (!Array.isArray(candles) || candles.length < 2) return '';

  const totalH = PRICE_H + (showVolume ? VOL_H + PAD : 0) + PAD * 2;

  // 주석선(돌파·익절·손절)도 스케일에 포함해야 화면 밖으로 나가지 않는다.
  const marks = [breakoutLevel, takeProfit, stopLoss].filter((v) => Number.isFinite(v) && v > 0);
  const min = Math.min(...candles.map((c) => c.low), ...marks);
  const max = Math.max(...candles.map((c) => c.high), ...marks);
  const y = scaleY({ min, max, top: PAD, height: PRICE_H });

  const slot = WIDTH / candles.length;
  const bodyW = Math.max(1.5, slot * 0.6);

  const bodies = candles
    .map((c, i) => {
      const cx = i * slot + slot / 2;
      const up = c.close >= c.open;
      const isLast = highlightLast && i === candles.length - 1;
      const top = y(Math.max(c.open, c.close));
      const bot = y(Math.min(c.open, c.close));
      const h = Math.max(1, bot - top);
      const cls = `body ${up ? 'up' : 'down'}${isLast ? ' hit' : ''}`;
      return (
        `<line class="wick" x1="${cx.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(c.low).toFixed(1)}"/>` +
        `<rect class="${cls}" x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${h.toFixed(1)}"/>`
      );
    })
    .join('');

  // 라벨 x를 서로 다르게 둔다 — 세 선이 가까이 붙으면 글자가 겹쳐 읽을 수 없다.
  const level = (value, cls, name, labelX) => {
    if (!Number.isFinite(value) || value <= 0) return '';
    const yy = y(value).toFixed(1);
    return (
      `<line class="level ${cls}" x1="0" y1="${yy}" x2="${WIDTH}" y2="${yy}"/>` +
      `<text class="ltext ${cls}" x="${labelX}" y="${(Number(yy) - 3).toFixed(1)}">${esc(`${name} ${formatPrice(value)}`)}</text>`
    );
  };

  let volume = '';
  if (showVolume) {
    const volTop = PAD + PRICE_H + PAD;
    const maxVol = Math.max(...candles.map((c) => c.volume), 0);
    const avgVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
    // 거래량이 전부 0인 구간(거래정지 등)에서도 좌표가 유한해야 한다.
    const vy = maxVol > 0 ? (v) => volTop + (1 - v / maxVol) * VOL_H : () => volTop + VOL_H;

    volume =
      candles
        .map((c, i) => {
          const cx = i * slot + slot / 2;
          const top = vy(c.volume);
          const isLast = highlightLast && i === candles.length - 1;
          return `<rect class="vol${isLast ? ' hit' : ''}" x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(0.5, volTop + VOL_H - top).toFixed(1)}"/>`;
        })
        .join('') +
      (maxVol > 0
        ? `<line class="volavg" x1="0" y1="${vy(avgVol).toFixed(1)}" x2="${WIDTH}" y2="${vy(avgVol).toFixed(1)}"/>`
        : `<line class="volavg" x1="0" y1="${(volTop + VOL_H).toFixed(1)}" x2="${WIDTH}" y2="${(volTop + VOL_H).toFixed(1)}"/>`);
  }

  return (
    `<svg class="chart" viewBox="0 0 ${WIDTH} ${totalH}" preserveAspectRatio="none" role="img"` +
    (label ? ` aria-label="${esc(label)}"` : '') +
    `>${bodies}` +
    level(breakoutLevel, 'breakout', '돌파선', 4) +
    level(takeProfit, 'tp', '익절', 200) +
    level(stopLoss, 'sl', '손절', 380) +
    volume +
    `</svg>`
  );
}

module.exports = { candleChart, scaleY, formatPrice, WIDTH, PRICE_H, VOL_H };

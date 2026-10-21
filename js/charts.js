/**
 * SnowF — Chart.js wrappers (hourly modal).
 * Degrades gracefully when Chart.js CDN is unavailable (offline).
 */

import { hourlySkiScore } from './recommendation.js';
import { isNum } from './weather.js';

let hourlyChart = null;

/**
 * Chart.js is loaded lazily (only when the hourly modal is opened the first
 * time) to keep the initial page load light. Fails gracefully offline.
 */
let chartPromise = null;
export function ensureChart() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Chart) return Promise.resolve(true);
  if (!chartPromise) {
    chartPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.Chart ? resolve(true) : reject(new Error('chart missing')));
      s.onerror = () => {
        chartPromise = null;
        reject(new Error('cdn failed'));
      };
      document.head.appendChild(s);
    });
  }
  return chartPromise;
}

function hasCharts() {
  return typeof window !== 'undefined' && typeof window.Chart !== 'undefined';
}

export function destroyHourlyChart() {
  if (hourlyChart) {
    try { hourlyChart.destroy(); } catch { /* ignore */ }
    hourlyChart = null;
  }
}

/**
 * Render temp / wind / snowfall / hourly-score for one station-day.
 * @param {HTMLCanvasElement} canvas
 * @param {Array} hours normalized hour rows
 * @param {number|null} depthCm
 */
export function renderHourlyChart(canvas, hours = [], depthCm = null) {
  if (!canvas || !hasCharts()) return false;
  destroyHourlyChart();

  const labels = hours.map((r) => (isNum(r.hour) ? `${String(r.hour).padStart(2, '0')}:00` : ''));
  const temps = hours.map((r) => (isNum(r.temp) ? Math.round(r.temp * 10) / 10 : null));
  const winds = hours.map((r) => (isNum(r.wind) ? Math.round(r.wind) : null));
  const snows = hours.map((r) => (isNum(r.snowfall) ? Math.round(r.snowfall * 10) / 10 : null));
  const scores = hours.map((r) => hourlySkiScore(r, depthCm).score);

  const dark = document.body.classList.contains('theme-night') || document.body.classList.contains('theme-aurora');
  const textColor = dark ? '#e0e7ff' : '#1e293b';
  const gridColor = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

  hourlyChart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'دما (°C)', data: temps, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.4, yAxisID: 'y', spanGaps: true },
        { label: 'باد (km/h)', data: winds, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, yAxisID: 'y', spanGaps: true },
        { label: 'برف (cm)', data: snows, borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.3)', fill: true, tension: 0.4, yAxisID: 'y', spanGaps: true },
        { label: 'امتیاز ساعتی', data: scores, borderColor: '#22c55e', borderDash: [6, 4], fill: false, tension: 0.4, yAxisID: 'y1', pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: textColor } } },
      scales: {
        x: { ticks: { color: textColor, maxTicksLimit: 12 }, grid: { color: gridColor } },
        y: { type: 'linear', display: true, position: 'left', ticks: { color: textColor }, grid: { color: gridColor } },
        y1: { type: 'linear', display: true, position: 'right', min: 0, max: 100, ticks: { color: textColor }, grid: { drawOnChartArea: false } },
      },
    },
  });
  return true;
}

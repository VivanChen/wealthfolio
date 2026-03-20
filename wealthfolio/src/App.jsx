import React, { useState, useEffect, useMemo } from 'react'
import { supabase, isDemoMode } from './supabase.js'
import { T, CHART_COLORS, CURRENCIES } from './i18n.js'
import { PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip } from 'recharts'
import * as XLSX from 'xlsx'

// ─── Helpers ───
const genId = () => crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)
const today = () => new Date().toISOString().slice(0, 10)
const fmtMoney = (n, sym = '$') => `${n < 0 ? '-' : ''}${sym}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
const safeSheet = (name) => name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31)

// Simple markdown to HTML renderer
function renderMarkdown(text) {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') // escape HTML
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/^---$/gm, '<hr/>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>')
    .replace(/^/, '<p>').replace(/$/, '</p>')
    .replace(/<p><h/g, '<h').replace(/<\/h(\d)><\/p>/g, '</h$1>')
    .replace(/<p><ul>/g, '<ul>').replace(/<\/ul><\/p>/g, '</ul>')
    .replace(/<p><hr\/><\/p>/g, '<hr/>')
    .replace(/<p><\/p>/g, '')
}
const LS_KEY = 'wf_holdings'
const LS_DIV = 'wf_dividends'
const LS_SNAP = 'wf_snapshots'
const LS_LIAB = 'wf_liabilities'
const LS_PRICES = 'wf_prices'
const loadLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d } catch { return d } }
const saveLS = (k, v) => localStorage.setItem(k, JSON.stringify(v))

// Auto-detect market from ticker input
function detectMarket(ticker) {
  if (!ticker) return null
  const t = ticker.trim()
  if (/^\d{4,5}(\.TW)?$/i.test(t)) return 'tw'
  if (/^[A-Z]/i.test(t)) return 'us'
  return null
}

// ─── Stock Price Fetching ───
async function fetchStockPrices(tickers) {
  if (!tickers.length) return {}
  try {
    const allTickers = [...tickers, 'USDTWD=X']
    const res = await fetch(`/api/stock-price?symbols=${allTickers.join(',')}`)
    if (!res.ok) throw new Error('API error')
    return await res.json()
  } catch (e) { console.warn('Price fetch failed:', e); return {} }
}

// ─── Portfolio Calculations ───
function calcPortfolio(holdings, prices, usdTwd = 32, dividends = []) {
  let totalValueTWD = 0, totalCostTWD = 0, totalDivTWD = 0
  const items = holdings.map(h => {
    const isStock = h.market !== 'cash'
    const priceData = prices[h.ticker]
    // For funds: use amount field as manual current NAV if no auto-price
    const currentPrice = priceData?.price || (h.asset_type === 'fund' && h.amount > 0 ? h.amount : h.avg_cost) || 0
    const rate = h.currency === 'USD' ? usdTwd : 1
    const holdingDivs = dividends.filter(d => d.holding_id === h.id)
    const totalDiv = holdingDivs.reduce((s, d) => s + (Number(d.total_amount) || 0), 0)

    let marketValue, costBasis, gain, gainPct
    if (isStock) {
      marketValue = (h.shares || 0) * currentPrice
      costBasis = (h.shares || 0) * (h.avg_cost || 0)
      gain = marketValue - costBasis
      gainPct = costBasis > 0 ? gain / costBasis : 0
    } else {
      marketValue = h.amount || 0; costBasis = h.amount || 0; gain = 0; gainPct = 0
    }
    const divYield = marketValue > 0 ? totalDiv / marketValue : 0
    const valueTWD = marketValue * rate
    const costTWD = costBasis * rate
    totalValueTWD += valueTWD; totalCostTWD += costTWD; totalDivTWD += totalDiv * rate
    return { ...h, currentPrice, marketValue, costBasis, gain, gainPct, valueTWD, costTWD, rate, priceData,
      totalDiv, totalDivTwd: totalDiv * rate, divYield, dividendCount: holdingDivs.length }
  })
  items.forEach(i => { i.weight = totalValueTWD > 0 ? i.valueTWD / totalValueTWD : 0 })
  return { items, totalValueTWD, totalCostTWD, totalGainTWD: totalValueTWD - totalCostTWD,
    totalGainPct: totalCostTWD > 0 ? (totalValueTWD - totalCostTWD) / totalCostTWD : 0, totalDivTWD }
}

// ─── Rule-Based Advice ───
function getRuleAdvice(portfolio, t, debtToAsset = 0, totalLiabTWD = 0) {
  const { items, totalValueTWD } = portfolio
  if (!items.length) return [{ text: t.advice.noData, type: 'info' }]
  const tips = []
  const stockVal = items.filter(i => i.market !== 'cash').reduce((s, i) => s + i.valueTWD, 0)
  const cashVal = items.filter(i => i.market === 'cash').reduce((s, i) => s + i.valueTWD, 0)
  const stockPct = totalValueTWD > 0 ? stockVal / totalValueTWD * 100 : 0
  const cashPct = totalValueTWD > 0 ? cashVal / totalValueTWD * 100 : 0
  if (stockPct > 80) tips.push({ text: t.advice.highStock.replace('{pct}', '80'), type: 'warn' })
  else if (stockPct < 30 && stockPct > 0) tips.push({ text: t.advice.lowStock.replace('{pct}', '30'), type: 'tip' })
  else if (items.length > 1) tips.push({ text: t.advice.goodBalance, type: 'good' })
  if (cashPct > 50) tips.push({ text: t.advice.highCash.replace('{pct}', '50'), type: 'tip' })
  const sorted = [...items].sort((a, b) => b.valueTWD - a.valueTWD)
  const top3 = totalValueTWD > 0 ? sorted.slice(0, 3).reduce((s, i) => s + i.valueTWD, 0) / totalValueTWD * 100 : 0
  if (top3 > 70 && items.length > 3) tips.push({ text: t.advice.lowDiversify.replace('{pct}', top3.toFixed(0)), type: 'warn' })
  else if (items.length > 3) tips.push({ text: t.advice.goodDiversify, type: 'good' })
  const mkts = new Set(items.map(i => i.market))
  if (mkts.size === 1 && items.length > 1) tips.push({ text: t.advice.singleMarket.replace('{market}', t.markets[items[0].market] || ''), type: 'tip' })
  // Debt ratio advice
  if (totalLiabTWD > 0) {
    const dta = debtToAsset * 100
    if (dta > 60) tips.push({ text: t.advice.highDebt.replace('{pct}', dta.toFixed(0)), type: 'warn' })
    else if (dta > 40) tips.push({ text: t.advice.moderateDebt.replace('{pct}', dta.toFixed(0)), type: 'tip' })
    else tips.push({ text: t.advice.healthyDebt.replace('{pct}', dta.toFixed(0)), type: 'good' })
  }
  return tips
}

// ─── Styles ───
const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08081a;--surface:#12122a;--surface2:#1a1a38;--surface3:#252550;
  --text:#eaeaf4;--text2:#9898b8;--text3:#5e5e80;
  --accent:#7c6cf0;--accent2:#b0a4ff;--accent-glow:rgba(124,108,240,0.2);
  --green:#2dd4bf;--green-bg:rgba(45,212,191,0.1);
  --red:#f472b6;--red-bg:rgba(244,114,182,0.1);
  --yellow:#fbbf24;--yellow-bg:rgba(251,191,36,0.1);
  --danger:#ef4444;--radius:16px;--radius-sm:12px;
  --font:'Noto Sans TC',system-ui,sans-serif;
  --mono:'JetBrains Mono',monospace;
  --safe-b:env(safe-area-inset-bottom,0px);
}
html{font-size:16px}
body{font-family:var(--font);background:var(--bg);color:var(--text);
  min-height:100dvh;overflow-x:hidden;-webkit-tap-highlight-color:transparent}
input,select,textarea,button{font-family:inherit;font-size:inherit}
button{cursor:pointer;border:none;background:none;color:inherit}

@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.fade-up{animation:fadeUp .4s cubic-bezier(.22,1,.36,1) both}
.s1{animation-delay:.04s}.s2{animation-delay:.08s}.s3{animation-delay:.12s}.s4{animation-delay:.16s}

/* App shell */
.app{max-width:480px;margin:0 auto;min-height:100dvh;padding-bottom:calc(72px + var(--safe-b));position:relative}

/* Bottom tabs */
.tab-bar{position:fixed;bottom:0;left:0;right:0;max-width:480px;margin:0 auto;
  background:rgba(12,12,28,.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border-top:1px solid rgba(255,255,255,.04);z-index:80;
  display:flex;padding:6px 0 calc(6px + var(--safe-b));
}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;
  padding:6px 0;color:var(--text3);transition:color .2s;position:relative}
.tab.active{color:var(--accent2)}
.tab-icon{font-size:1.25rem;line-height:1}
.tab-label{font-size:.6rem;font-weight:500}
.tab-dot{position:absolute;top:4px;right:calc(50% - 16px);width:5px;height:5px;
  border-radius:50%;background:var(--accent)}

/* Header */
.header{padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;
  position:sticky;top:0;z-index:50;background:rgba(8,8,26,.9);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.header h1{font-size:1.05rem;font-weight:600;letter-spacing:-.02em}
.header-actions{display:flex;gap:6px}
.icon-btn{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:var(--surface);transition:all .2s;font-size:1.05rem}
.icon-btn:active{transform:scale(.88);opacity:.7}

/* Summary */
.summary{padding:6px 16px 12px}
.hero-card{background:linear-gradient(145deg,#181848,#241860,#1a1a50);border-radius:var(--radius);
  padding:22px 24px 18px;position:relative;overflow:hidden}
.hero-card::before{content:'';position:absolute;top:-50%;right:-30%;width:220px;height:220px;
  border-radius:50%;background:radial-gradient(circle,rgba(124,108,240,.18),transparent 70%)}
.hero-card::after{content:'';position:absolute;bottom:-30%;left:-20%;width:180px;height:180px;
  border-radius:50%;background:radial-gradient(circle,rgba(45,212,191,.08),transparent 70%)}
.hero-label{font-size:.7rem;color:var(--text2);font-weight:400;letter-spacing:.04em}
.hero-amount{font-family:var(--mono);font-size:2rem;font-weight:700;margin:4px 0 6px;letter-spacing:-.03em}
.hero-change{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:.82rem;
  padding:3px 10px;border-radius:20px;font-weight:600}
.hero-change.up{background:var(--green-bg);color:var(--green)}
.hero-change.down{background:var(--red-bg);color:var(--red)}

.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px 16px 0}
.stat{background:var(--surface);border-radius:var(--radius-sm);padding:12px}
.stat .label{font-size:.65rem;color:var(--text2);font-weight:500;letter-spacing:.03em}
.stat .val{font-family:var(--mono);font-size:.88rem;font-weight:600;margin-top:3px;color:var(--text)}
.stat .val.up{color:#34d399}.stat .val.down{color:#fb7185}
.stat .val.gold{color:#fcd34d}

/* Charts */
.charts{display:flex;gap:8px;padding:8px 16px}
.chart-box{flex:1;background:var(--surface);border-radius:var(--radius-sm);padding:10px 6px 4px}
.chart-title{font-size:.68rem;color:var(--text2);text-align:center;font-weight:500;letter-spacing:.03em}
.chart-legend{display:flex;flex-wrap:wrap;gap:3px 8px;padding:4px 6px 2px;justify-content:center}
.legend-item{display:flex;align-items:center;gap:3px;font-size:.62rem;color:var(--text)}
.legend-dot{width:6px;height:6px;border-radius:2px;flex-shrink:0}

/* Trend */
.trend-box{margin:8px 16px 4px;background:var(--surface);border-radius:var(--radius-sm);padding:14px 10px 6px}
.trend-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 4px}
.trend-title{font-size:.72rem;font-weight:500;color:var(--text2)}
.trend-change{font-family:var(--mono);font-size:.7rem;margin-top:2px}
.period-tabs{display:flex;gap:3px}
.period-tab{font-size:.6rem;padding:4px 10px;border-radius:12px;color:var(--text3);transition:all .15s}
.period-tab.active{color:var(--accent2);background:var(--accent-glow)}
.period-tab:active{transform:scale(.9)}

/* Holdings */
.section-header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px 8px}
.section-header h2{font-size:.82rem;font-weight:600;color:var(--text2)}
.section-header .count{font-size:.7rem;color:var(--text3);font-family:var(--mono)}
.holdings{padding:0 16px}
.h-card{display:flex;align-items:center;gap:12px;padding:14px;
  background:var(--surface);border-radius:var(--radius-sm);margin-bottom:6px;
  transition:all .15s;border:1px solid transparent}
.h-card:active{transform:scale(.98);border-color:rgba(255,255,255,.04)}
.h-icon{width:42px;height:42px;border-radius:var(--radius-sm);display:flex;align-items:center;
  justify-content:center;font-size:1.15rem;flex-shrink:0}
.h-icon.us{background:linear-gradient(135deg,rgba(116,185,255,.12),rgba(116,185,255,.05))}
.h-icon.tw{background:linear-gradient(135deg,rgba(251,191,36,.12),rgba(251,191,36,.05))}
.h-icon.cash{background:linear-gradient(135deg,rgba(45,212,191,.12),rgba(45,212,191,.05))}
.h-body{flex:1;min-width:0}
.h-name{font-size:.85rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.h-meta{display:flex;align-items:center;gap:6px;margin-top:2px}
.h-ticker{font-size:.65rem;color:var(--text3);font-family:var(--mono);background:var(--surface2);
  padding:1px 5px;border-radius:4px}
.h-div-badge{font-size:.58rem;color:var(--yellow);background:var(--yellow-bg);
  padding:1px 6px;border-radius:4px;font-family:var(--mono)}
.h-right{text-align:right;flex-shrink:0}
.h-value{font-family:var(--mono);font-size:.88rem;font-weight:600}
.h-gain{font-family:var(--mono);font-size:.65rem;margin-top:2px}
.h-gain.up{color:var(--green)}.h-gain.down{color:var(--red)}
.h-pct{font-size:.58rem;color:var(--text3);margin-top:1px;font-family:var(--mono)}

.empty{text-align:center;padding:60px 20px;color:var(--text3)}
.empty .emoji{font-size:3rem;margin-bottom:12px;filter:grayscale(.3)}
.empty p{font-size:.88rem;line-height:1.5}

/* FAB */
.fab{position:fixed;bottom:calc(80px + var(--safe-b));right:max(16px,calc(50% - 224px));
  width:54px;height:54px;border-radius:50%;background:var(--accent);color:#fff;font-size:1.8rem;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 6px 24px rgba(124,108,240,.4);z-index:85;transition:all .2s}
.fab:active{transform:scale(.88)}

/* Sheet */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;
  opacity:0;transition:opacity .3s;pointer-events:none}
.overlay.open{opacity:1;pointer-events:all}
.sheet{position:fixed;bottom:0;left:0;right:0;max-width:480px;margin:0 auto;
  background:var(--surface);border-radius:20px 20px 0 0;z-index:201;
  transform:translateY(100%);transition:transform .35s cubic-bezier(.32,.72,0,1);
  max-height:90dvh;overflow-y:auto;padding:0 20px calc(24px + var(--safe-b))}
.sheet.open{transform:translateY(0)}
.sheet-handle{width:36px;height:4px;border-radius:2px;background:var(--text3);
  margin:10px auto 16px;opacity:.4}
.sheet-title{font-size:1.05rem;font-weight:600;margin-bottom:18px;text-align:center}

/* Form — cleaner */
.form-group{margin-bottom:14px}
.form-label{font-size:.72rem;color:var(--text2);margin-bottom:5px;display:block;font-weight:500}
.form-input{width:100%;padding:12px 14px;border-radius:var(--radius-sm);border:1.5px solid var(--surface3);
  background:var(--surface2);color:var(--text);font-size:.92rem;outline:none;transition:all .2s}
.form-input:focus{border-color:var(--accent);background:rgba(124,108,240,.04)}
.form-input::placeholder{color:var(--text3)}
select.form-input{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235e5e80' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center}
.form-row{display:flex;gap:8px}
.form-row .form-group{flex:1}
.form-hint{font-size:.62rem;color:var(--text3);margin-top:3px}

/* Smart ticker input with auto-detect badge */
.ticker-wrapper{position:relative}
.ticker-wrapper .detect-badge{position:absolute;right:10px;top:50%;transform:translateY(-50%);
  font-size:.6rem;padding:2px 8px;border-radius:8px;font-weight:600;pointer-events:none}
.detect-badge.us{background:rgba(116,185,255,.15);color:#74b9ff}
.detect-badge.tw{background:rgba(251,191,36,.15);color:#fbbf24}

.type-chips{display:flex;gap:6px;flex-wrap:wrap}
.type-chip{padding:8px 14px;border-radius:20px;font-size:.78rem;border:1.5px solid var(--surface3);
  transition:all .2s;font-weight:500}
.type-chip:active{transform:scale(.94)}
.type-chip.active{border-color:var(--accent);background:var(--accent-glow);color:var(--accent2)}

.btn-primary{width:100%;padding:14px;border-radius:var(--radius-sm);background:var(--accent);
  color:#fff;font-weight:600;font-size:.92rem;margin-top:8px;transition:all .2s;
  box-shadow:0 4px 16px rgba(124,108,240,.25)}
.btn-primary:active{transform:scale(.97);box-shadow:none}
.btn-primary:disabled{opacity:.4;box-shadow:none}
.btn-outline{width:100%;padding:12px;border-radius:var(--radius-sm);margin-top:6px;
  border:1.5px solid var(--surface3);color:var(--text2);font-weight:500;font-size:.85rem;transition:all .2s}
.btn-outline:active{background:var(--surface2)}
.btn-danger{width:100%;padding:12px;border-radius:var(--radius-sm);margin-top:6px;
  border:1.5px solid rgba(239,68,68,.3);color:var(--danger);font-weight:500;font-size:.85rem}
.btn-danger:active{background:rgba(239,68,68,.06)}

/* Advisor */
.advice-list{padding:0 16px 12px;display:flex;flex-direction:column;gap:6px}
.advice-card{background:var(--surface);border-radius:var(--radius-sm);padding:14px 16px;
  font-size:.82rem;line-height:1.5;border-left:3px solid var(--surface3)}
.advice-card.warn{border-color:var(--yellow)}.advice-card.good{border-color:var(--green)}
.advice-card.tip{border-color:var(--accent2)}.advice-card.info{border-color:var(--text3)}
.ai-box{margin:0 16px 16px;background:var(--surface);border-radius:var(--radius-sm);
  padding:16px 18px;font-size:.82rem;line-height:1.7}
.ai-box h1{font-size:1rem;font-weight:600;color:var(--accent2);margin:16px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--surface3)}
.ai-box h2{font-size:.95rem;font-weight:600;color:var(--accent2);margin:14px 0 6px}
.ai-box h3{font-size:.88rem;font-weight:600;color:var(--text);margin:12px 0 4px}
.ai-box strong{color:var(--text);font-weight:600}
.ai-box ul,.ai-box ol{padding-left:18px;margin:6px 0}
.ai-box li{margin:3px 0}
.ai-box hr{border:none;border-top:1px solid var(--surface3);margin:12px 0}
.ai-box p{margin:6px 0}

/* Settings */
.setting-group{margin-bottom:20px}
.setting-label{font-size:.72rem;color:var(--text3);margin-bottom:8px;font-weight:500}
.lang-picker{display:flex;gap:8px}
.lang-btn{flex:1;padding:14px;border-radius:var(--radius-sm);border:1.5px solid var(--surface3);
  text-align:center;font-size:.88rem;transition:all .2s}
.lang-btn.active{border-color:var(--accent);background:var(--accent-glow)}
.lang-btn .flag{font-size:1.4rem;display:block;margin-bottom:3px}
.user-card{display:flex;align-items:center;gap:10px;padding:14px;
  background:var(--surface2);border-radius:var(--radius-sm)}
.user-avatar{width:36px;height:36px;border-radius:50%;background:var(--accent);
  display:flex;align-items:center;justify-content:center;font-size:.9rem;color:#fff;font-weight:600}
.user-info .name{font-size:.82rem;font-weight:500}
.user-info .hint{font-size:.65rem;color:var(--text3)}

/* Auth */
.auth-page{display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:100dvh;padding:32px 24px;background:var(--bg)}
.auth-logo{font-size:3rem;margin-bottom:8px}
.auth-title{font-size:1.4rem;font-weight:700;margin-bottom:2px}
.auth-sub{font-size:.8rem;color:var(--text2);margin-bottom:28px}
.auth-form{width:100%;max-width:340px}
.auth-switch{font-size:.8rem;color:var(--accent2);text-align:center;margin-top:16px;text-decoration:underline}
.auth-error{font-size:.75rem;color:var(--danger);text-align:center;margin-top:8px}

.demo-banner{background:linear-gradient(90deg,rgba(124,108,240,.1),rgba(45,212,191,.06));
  text-align:center;padding:6px 16px;font-size:.68rem;color:var(--accent2);font-weight:500}

.confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;
  display:flex;align-items:center;justify-content:center;padding:24px}
.confirm-box{background:var(--surface);border-radius:var(--radius);padding:24px;
  max-width:300px;width:100%;text-align:center}
.confirm-box p{font-size:.88rem;margin-bottom:18px;line-height:1.4}
.confirm-actions{display:flex;gap:10px}
.confirm-actions button{flex:1;padding:11px;border-radius:var(--radius-sm);font-weight:500;font-size:.85rem}
.confirm-actions .yes{background:var(--danger);color:#fff}
.confirm-actions .no{background:var(--surface2);color:var(--text2)}

/* Dividend mini */
.div-section{padding:0 16px 12px}
.div-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.div-header h3{font-size:.82rem;font-weight:500}
.div-add-btn{font-size:.72rem;color:var(--accent2);padding:5px 12px;border-radius:14px;
  border:1px solid var(--accent-glow);transition:all .2s}
.div-item{display:flex;align-items:center;justify-content:space-between;
  padding:10px 14px;background:var(--surface2);border-radius:10px;margin-bottom:4px;font-size:.78rem}
.div-item-left{display:flex;flex-direction:column;gap:2px}
.div-item-date{color:var(--text3);font-size:.65rem;font-family:var(--mono)}
.div-item-type{color:var(--text2);font-size:.62rem}
.div-item-amount{font-family:var(--mono);font-weight:600;color:var(--yellow)}
.div-item-del{color:var(--text3);font-size:1rem;padding:10px;margin:-10px;transition:color .2s;min-width:40px;min-height:40px;display:flex;align-items:center;justify-content:center}
.div-item-del:active{color:var(--danger);background:rgba(239,68,68,.1);border-radius:8px}
.div-total-row{display:flex;justify-content:space-between;padding:8px 14px;
  border-top:1px solid var(--surface3);margin-top:4px;font-size:.78rem;font-weight:500}
.div-total-row .val{color:var(--yellow);font-family:var(--mono)}

::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:2px}
`

// ─── App ───
export default function App() {
  const lang = 'zh-TW'
  const [user, setUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [tab, setTab] = useState('dashboard')
  const [holdings, setHoldings] = useState([])
  const [dividends, setDividends] = useState([])
  const [liabilities, setLiabilities] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [trendPeriod, setTrendPeriod] = useState('30d')
  const [prices, setPrices] = useState(() => loadLS(LS_PRICES, {}))
  const [refreshing, setRefreshing] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingItem, setEditingItem] = useState(null)
  const [showLiabForm, setShowLiabForm] = useState(false)
  const [editingLiab, setEditingLiab] = useState(null)
  const [showDivForm, setShowDivForm] = useState(false)
  const [divFormHolding, setDivFormHolding] = useState(null)
  const [showHoldingDetail, setShowHoldingDetail] = useState(null)
  const [aiResult, setAiResult] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const t = T[lang]

  // Auth
  useEffect(() => {
    if (isDemoMode) {
      setAuthChecked(true); setUser({ email: 'demo' })
      setHoldings(loadLS(LS_KEY, [])); setDividends(loadLS(LS_DIV, [])); setSnapshots(loadLS(LS_SNAP, [])); setLiabilities(loadLS(LS_LIAB, []))
      return
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user || null); setAuthChecked(true)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user || null))
    return () => subscription.unsubscribe()
  }, [])

  // Load data — filtered by user_email (defense-in-depth, RLS also enforces)
  useEffect(() => {
    if (isDemoMode || !user) return
    const email = user.email
    const f1 = async () => {
      const { data } = await supabase.from('holdings').select('*')
        .eq('user_email', email).order('created_at', { ascending: false })
      if (data) setHoldings(data)
    }
    const f2 = async () => {
      const { data } = await supabase.from('dividends').select('*')
        .eq('user_email', email).order('div_date', { ascending: false })
      if (data) setDividends(data)
    }
    const f3 = async () => {
      const { data } = await supabase.from('snapshots').select('*')
        .eq('user_email', email).order('snap_date', { ascending: true })
      if (data) setSnapshots(data)
    }
    const f4 = async () => {
      const { data } = await supabase.from('liabilities').select('*')
        .eq('user_email', email).order('created_at', { ascending: false })
      if (data) setLiabilities(data)
    }
    f1(); f2(); f3(); f4()
    // Realtime — only listen to this user's changes
    const ch = supabase.channel(`user_${email}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'holdings', filter: `user_email=eq.${email}` }, () => f1())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dividends', filter: `user_email=eq.${email}` }, () => f2())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'liabilities', filter: `user_email=eq.${email}` }, () => f4())
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [user])

  useEffect(() => { if (holdings.length) refreshPrices() }, [holdings.length > 0])

  const refreshPrices = async () => {
    const tickers = holdings.filter(h => h.market !== 'cash' && h.ticker).map(h => h.ticker)
    if (!tickers.length) return
    setRefreshing(true)
    const data = await fetchStockPrices(tickers)
    if (Object.keys(data).length) { setPrices(data); saveLS(LS_PRICES, data) }
    setRefreshing(false)
  }

  const usdTwd = prices['USDTWD=X']?.price || 32
  const portfolio = useMemo(() => calcPortfolio(holdings, prices, usdTwd, dividends), [holdings, prices, usdTwd, dividends])

  const marketAlloc = useMemo(() => {
    const m = {}; portfolio.items.forEach(i => { const k = t.markets[i.market] || i.market; m[k] = (m[k] || 0) + i.valueTWD })
    return Object.entries(m).map(([name, value]) => ({ name, value })).filter(d => d.value > 0)
  }, [portfolio, t])
  const typeAlloc = useMemo(() => {
    const m = {}; portfolio.items.forEach(i => { const k = t.assetTypes[i.asset_type] || i.asset_type; m[k] = (m[k] || 0) + i.valueTWD })
    return Object.entries(m).map(([name, value]) => ({ name, value })).filter(d => d.value > 0)
  }, [portfolio, t])

  // Snapshots
  useEffect(() => {
    if (!portfolio.totalValueTWD || portfolio.totalValueTWD <= 0) return
    const td = today()
    const existing = snapshots.find(s => s.snap_date === td)
    if (existing && Math.abs(existing.total_value_twd - portfolio.totalValueTWD) < 1) return
    const snap = { snap_date: td, total_value_twd: Math.round(portfolio.totalValueTWD), total_cost_twd: Math.round(portfolio.totalCostTWD), total_div_twd: Math.round(portfolio.totalDivTWD || 0) }
    if (isDemoMode) {
      const up = existing ? snapshots.map(s => s.snap_date === td ? { ...s, ...snap } : s) : [...snapshots, { ...snap, id: genId() }]
      setSnapshots(up); saveLS(LS_SNAP, up)
    } else {
      if (existing) supabase.from('snapshots').update(snap).eq('id', existing.id)
      else supabase.from('snapshots').insert({ ...snap, user_email: user?.email || '' })
    }
  }, [portfolio.totalValueTWD])

  const trendData = useMemo(() => {
    if (!snapshots.length) return []
    let cutoff = null; const now = new Date()
    if (trendPeriod === '7d') cutoff = new Date(now - 7 * 86400000)
    else if (trendPeriod === '30d') cutoff = new Date(now - 30 * 86400000)
    else if (trendPeriod === '90d') cutoff = new Date(now - 90 * 86400000)
    return snapshots.filter(s => !cutoff || new Date(s.snap_date) >= cutoff)
      .map(s => ({ date: s.snap_date.slice(5), fullDate: s.snap_date, value: s.total_value_twd, cost: s.total_cost_twd }))
  }, [snapshots, trendPeriod])

  // CRUD
  const handleSave = async (item) => {
    if (isDemoMode) {
      let up; if (item.id && holdings.find(h => h.id === item.id)) up = holdings.map(h => h.id === item.id ? { ...h, ...item } : h)
      else up = [{ ...item, id: genId(), user_email: 'demo', created_at: new Date().toISOString() }, ...holdings]
      setHoldings(up); saveLS(LS_KEY, up)
    } else {
      if (item.id) await supabase.from('holdings').update(item).eq('id', item.id)
      else await supabase.from('holdings').insert({ ...item, user_email: user.email })
    }
    setShowForm(false); setEditingItem(null)
  }
  const handleDelete = async (id) => {
    if (isDemoMode) {
      const up = holdings.filter(h => h.id !== id)
      setHoldings(up); saveLS(LS_KEY, up)
      // Clean up orphaned dividends
      const upDiv = dividends.filter(d => d.holding_id !== id)
      setDividends(upDiv); saveLS(LS_DIV, upDiv)
    }
    else await supabase.from('holdings').delete().eq('id', id)
    setConfirmDelete(null); setShowForm(false); setEditingItem(null)
  }
  const handleSaveDividend = async (div) => {
    if (isDemoMode) { const up = [{ ...div, id: genId(), user_email: 'demo', created_at: new Date().toISOString() }, ...dividends]; setDividends(up); saveLS(LS_DIV, up) }
    else await supabase.from('dividends').insert({ ...div, user_email: user.email })
    setShowDivForm(false); setDivFormHolding(null)
  }
  const handleDeleteDividend = async (id) => {
    // Optimistic update — remove from UI immediately
    setDividends(prev => prev.filter(d => d.id !== id))
    if (isDemoMode) {
      saveLS(LS_DIV, dividends.filter(d => d.id !== id))
    } else {
      await supabase.from('dividends').delete().eq('id', id)
    }
  }

  // Batch generate dividends
  const handleBatchDividends = async (divList) => {
    if (isDemoMode) {
      const newDivs = divList.map(d => ({ ...d, id: genId(), user_email: 'demo', created_at: new Date().toISOString() }))
      const updated = [...newDivs, ...dividends]
      setDividends(updated); saveLS(LS_DIV, updated)
    } else {
      const withEmail = divList.map(d => ({ ...d, user_email: user.email }))
      await supabase.from('dividends').insert(withEmail)
      // Refresh
      const { data } = await supabase.from('dividends').select('*')
        .eq('user_email', user.email).order('div_date', { ascending: false })
      if (data) setDividends(data)
    }
    setShowDivForm(false); setDivFormHolding(null)
  }

  // Liability CRUD
  const handleSaveLiability = async (item) => {
    if (isDemoMode) {
      let up; if (item.id && liabilities.find(l => l.id === item.id)) up = liabilities.map(l => l.id === item.id ? { ...l, ...item } : l)
      else up = [{ ...item, id: genId(), user_email: 'demo', created_at: new Date().toISOString() }, ...liabilities]
      setLiabilities(up); saveLS(LS_LIAB, up)
    } else {
      if (item.id) await supabase.from('liabilities').update(item).eq('id', item.id)
      else await supabase.from('liabilities').insert({ ...item, user_email: user.email })
    }
    setShowLiabForm(false); setEditingLiab(null)
  }
  const handleDeleteLiability = async (id) => {
    if (isDemoMode) { const up = liabilities.filter(l => l.id !== id); setLiabilities(up); saveLS(LS_LIAB, up) }
    else await supabase.from('liabilities').delete().eq('id', id)
    setShowLiabForm(false); setEditingLiab(null)
  }

  // Net worth & cash flow
  const totalLiabTWD = useMemo(() => {
    return liabilities.reduce((s, l) => {
      const rate = l.currency === 'USD' ? usdTwd : 1
      return s + (Number(l.remaining_amount) || 0) * rate
    }, 0)
  }, [liabilities, usdTwd])

  const netWorth = portfolio.totalValueTWD - totalLiabTWD

  const monthlyPayments = useMemo(() => {
    return liabilities.reduce((s, l) => {
      const rate = l.currency === 'USD' ? usdTwd : 1
      return s + (Number(l.monthly_payment) || 0) * rate
    }, 0)
  }, [liabilities, usdTwd])

  const monthlyDivIncome = useMemo(() => {
    if (!dividends.length || !portfolio.items.length) return 0
    // Estimate monthly from total dividends / months of data
    const dates = dividends.map(d => new Date(d.div_date)).sort((a, b) => a - b)
    if (dates.length < 1) return 0
    const months = Math.max(1, (Date.now() - dates[0].getTime()) / (30 * 86400000))
    return portfolio.totalDivTWD / months
  }, [dividends, portfolio])

  const debtToAsset = portfolio.totalValueTWD > 0 ? totalLiabTWD / portfolio.totalValueTWD : 0

  const ruleAdvice = useMemo(() => getRuleAdvice(portfolio, t, debtToAsset, totalLiabTWD), [portfolio, t, debtToAsset, totalLiabTWD])

  // AI
  // AI daily limit: 10 per user per day
  const AI_DAILY_LIMIT = 10
  const getAiUsageKey = () => `wf_ai_${user?.email || 'demo'}_${today()}`
  const getAiUsageCount = () => {
    try { const d = JSON.parse(localStorage.getItem(getAiUsageKey())); return d || 0 } catch { return 0 }
  }
  const incAiUsage = () => {
    const count = getAiUsageCount() + 1
    localStorage.setItem(getAiUsageKey(), JSON.stringify(count))
    return count
  }

  const getAiAdvice = async () => {
    const used = getAiUsageCount()
    if (used >= AI_DAILY_LIMIT) {
      setAiResult(t.aiDailyLimit.replace('{n}', AI_DAILY_LIMIT))
      return
    }
    setAiLoading(true); setAiResult('')
    try {
      const summary = { total_value_twd: Math.round(portfolio.totalValueTWD), total_gain_pct: (portfolio.totalGainPct * 100).toFixed(1) + '%', usd_twd_rate: usdTwd,
        total_liabilities_twd: Math.round(totalLiabTWD), net_worth_twd: Math.round(netWorth),
        debt_to_asset_ratio: (debtToAsset * 100).toFixed(1) + '%',
        monthly_loan_payments_twd: Math.round(monthlyPayments),
        liabilities: liabilities.map(l => ({ name: l.name, type: l.liability_type, remaining: l.remaining_amount, rate: l.interest_rate + '%', monthly: l.monthly_payment })),
        holdings: portfolio.items.map(i => ({ name: i.name || i.ticker, market: i.market, type: i.asset_type, value_twd: Math.round(i.valueTWD), weight: (i.weight * 100).toFixed(1) + '%', gain_pct: (i.gainPct * 100).toFixed(1) + '%', currency: i.currency })) }
      const res = await fetch('/api/ai-advice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portfolio: summary, lang }) })
      const data = await res.json(); setAiResult(data.advice || data.error || 'Error')
      incAiUsage()
    } catch (e) { setAiResult(t.aiNotConfigured) }
    setAiLoading(false)
  }

  // Export
  const exportExcel = () => {
    const wb = XLSX.utils.book_new()

    // Sheet 1: Summary
    const summaryData = [
      [t.netWorth, Math.round(netWorth)],
      [t.totalValue, Math.round(portfolio.totalValueTWD)],
      [t.totalCost, Math.round(portfolio.totalCostTWD)],
      [t.totalGain, Math.round(portfolio.totalGainTWD)],
      [t.gainPct, (portfolio.totalGainPct * 100).toFixed(1) + '%'],
      [t.totalDividends, Math.round(portfolio.totalDivTWD)],
      [t.totalLiabilities, Math.round(totalLiabTWD)],
      [t.monthlyLoanPayment, Math.round(monthlyPayments)],
      [t.debtToAsset, (debtToAsset * 100).toFixed(1) + '%'],
      ['USD/TWD', usdTwd.toFixed(2)],
      [t.lastUpdate, today()],
    ]
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData)
    wsSummary['!cols'] = [{ wch: 18 }, { wch: 18 }]
    XLSX.utils.book_append_sheet(wb, wsSummary, safeSheet(t.dashboard))

    // Sheet 2: Holdings
    const rows = portfolio.items.map(i => ({
      [t.market]: t.markets[i.market], [t.assetType]: t.assetTypes[i.asset_type],
      [t.ticker]: i.ticker || '-', [t.name]: i.name || '-', [t.shares]: i.shares || '-',
      [t.avgCost]: i.avg_cost || '-', [t.price]: i.currentPrice || '-',
      [t.currency]: i.currency,
      [t.gain]: i.market !== 'cash' ? Math.round(i.gain) : '-',
      [t.gainPct]: i.market !== 'cash' ? (i.gainPct * 100).toFixed(1) + '%' : '-',
      [t.totalDividends]: i.totalDiv > 0 ? Math.round(i.totalDiv) : '-',
      [t.weight]: (i.weight * 100).toFixed(1) + '%',
    }))
    if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), safeSheet(t.holdings))

    // Sheet 3: Dividends
    if (dividends.length) {
      const dr = dividends.map(d => { const h = holdings.find(x => x.id === d.holding_id)
        return { [t.divDate]: d.div_date, [t.ticker]: h?.ticker || '-', [t.name]: h?.name || '-',
          [t.divType]: t.divTypes[d.div_type] || d.div_type, [t.divPerShare]: d.per_share || '-',
          [t.divTotal]: d.total_amount, [t.currency]: d.currency || 'TWD' } })
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dr), safeSheet(t.dividends))
    }

    // Sheet 4: Liabilities
    if (liabilities.length) {
      const lr = liabilities.map(l => ({
        [t.liabilityType]: t.liabilityTypes[l.liability_type] || l.liability_type,
        [t.name]: l.name, [t.totalAmount]: l.total_amount,
        [t.remainingAmount]: l.remaining_amount, [t.interestRate]: l.interest_rate + '%',
        [t.monthlyPayment]: l.monthly_payment, [t.currency]: l.currency,
        [t.startDate]: l.start_date || '-', [t.endDate]: l.end_date || '-',
        [t.note]: l.note || '',
      }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lr), safeSheet(t.liabilities))
    }

    XLSX.writeFile(wb, `wealthfolio_${today()}.xlsx`)
  }

  if (!authChecked) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh', background: '#08081a' }}>
    <div style={{ animation: 'pulse 1.5s infinite', fontSize: '2.5rem' }}>📊</div></div>

  if (!user && !isDemoMode) return <AuthPage t={t} />

  return (
    <><style>{CSS}</style>
    <div className="app">
      {isDemoMode && <div className="demo-banner">⚡ {t.demoMode}</div>}

      {/* Header */}
      <div className="header">
        <h1>📊 {t.appName}</h1>
        <div className="header-actions">
          <button className="icon-btn" onClick={refreshPrices} disabled={refreshing}>{refreshing ? '⏳' : '🔄'}</button>
          <button className="icon-btn" onClick={exportExcel}>📥</button>
        </div>
      </div>

      {/* ─── Dashboard Tab ─── */}
      {tab === 'dashboard' && (
        <div className="fade-up">
          <div className="summary">
            <div className="hero-card">
              <div className="hero-label">{t.netWorth}</div>
              <div className="hero-amount">{fmtMoney(netWorth, 'NT$')}</div>
              <span className={`hero-change ${portfolio.totalGainTWD >= 0 ? 'up' : 'down'}`}>
                {portfolio.totalGainTWD >= 0 ? '▲' : '▼'} {fmtMoney(portfolio.totalGainTWD, 'NT$')}
                &nbsp;({portfolio.totalGainPct >= 0 ? '+' : ''}{(portfolio.totalGainPct * 100).toFixed(1)}%)
              </span>
            </div>
          </div>
          <div className="stats">
            <div className="stat"><div className="label">{t.totalValue}</div><div className="val">{fmtMoney(portfolio.totalValueTWD, 'NT$')}</div></div>
            <div className="stat"><div className="label">{t.totalLiabilities}</div>
              <div className="val down">{totalLiabTWD > 0 ? '-' : ''}{fmtMoney(totalLiabTWD, 'NT$')}</div></div>
            <div className="stat"><div className="label">{t.totalGain}</div>
              <div className={`val ${portfolio.totalGainTWD >= 0 ? 'up' : 'down'}`}>{portfolio.totalGainTWD >= 0 ? '+' : ''}{fmtMoney(portfolio.totalGainTWD, 'NT$')}</div></div>
          </div>
          {/* Cash flow row */}
          <div className="stats s1 fade-up">
            <div className="stat"><div className="label">🎁 {t.monthlyDividend}</div>
              <div className="val gold">{fmtMoney(monthlyDivIncome, 'NT$')}</div></div>
            <div className="stat"><div className="label">💳 {t.monthlyLoanPayment}</div>
              <div className="val down">{monthlyPayments > 0 ? '-' : ''}{fmtMoney(monthlyPayments, 'NT$')}</div></div>
            <div className="stat"><div className="label">{t.debtToAsset}</div>
              <div className={`val ${debtToAsset > 0.5 ? 'down' : debtToAsset > 0.3 ? 'gold' : 'up'}`}>{(debtToAsset * 100).toFixed(1)}%</div></div>
          </div>
          {portfolio.items.length > 0 && (
            <div className="charts s2 fade-up">
              <MiniPie title={t.byMarket} data={marketAlloc} />
              <MiniPie title={t.byType} data={typeAlloc} />
            </div>
          )}
          {trendData.length >= 2 && <TrendChart t={t} data={trendData} period={trendPeriod} setPeriod={setTrendPeriod} />}
        </div>
      )}

      {/* ─── Holdings Tab ─── */}
      {tab === 'holdings' && (
        <div className="fade-up">
          <div className="section-header">
            <h2>{t.holdings}</h2>
            <span className="count">{portfolio.items.length}</span>
          </div>
          <div className="holdings">
            {portfolio.items.length === 0 ? (
              <div className="empty"><div className="emoji">📈</div><p>{t.noHoldings}</p></div>
            ) : portfolio.items.map(item => (
              <div className="h-card" key={item.id} onClick={() => { setEditingItem(item); setShowForm(true) }}>
                <div className={`h-icon ${item.market}`}>
                  {item.market === 'us' ? '🇺🇸' : item.market === 'tw' ? '🇹🇼' : '💵'}
                </div>
                <div className="h-body">
                  <div className="h-name">{item.name || item.ticker || t.assetTypes[item.asset_type]}</div>
                  <div className="h-meta">
                    {item.ticker && <span className="h-ticker">{item.ticker}</span>}
                    {item.totalDiv > 0 && <span className="h-div-badge">🎁 {fmtMoney(item.totalDiv, CURRENCIES[item.currency]?.symbol || '$')}</span>}
                  </div>
                </div>
                <div className="h-right">
                  <div className="h-value">{fmtMoney(item.marketValue, CURRENCIES[item.currency]?.symbol || '$')}</div>
                  {item.market !== 'cash' && (
                    <div className={`h-gain ${item.gain >= 0 ? 'up' : 'down'}`}>
                      {item.gain >= 0 ? '+' : ''}{fmtMoney(item.gain, CURRENCIES[item.currency]?.symbol || '$')}
                      ({item.gainPct >= 0 ? '+' : ''}{(item.gainPct * 100).toFixed(1)}%)
                    </div>
                  )}
                  <div className="h-pct">{(item.weight * 100).toFixed(1)}%</div>
                </div>
              </div>
            ))}
          </div>

          {/* Liabilities Section */}
          <div className="section-header" style={{ marginTop: 8 }}>
            <h2>💳 {t.liabilities}</h2>
            <button className="div-add-btn" onClick={() => { setEditingLiab(null); setShowLiabForm(true) }}>+ {t.addLiability}</button>
          </div>
          <div className="holdings">
            {liabilities.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text3)', fontSize: '.82rem' }}>{t.noLiabilities}</div>
            ) : liabilities.map(l => {
              const sym = CURRENCIES[l.currency]?.symbol || 'NT$'
              const progress = l.total_amount > 0 ? (1 - (l.remaining_amount / l.total_amount)) * 100 : 0
              return (
                <div className="h-card" key={l.id} onClick={() => { setEditingLiab(l); setShowLiabForm(true) }}>
                  <div className="h-icon" style={{ background: 'var(--red-bg)' }}>
                    {l.liability_type === 'mortgage' ? '🏠' : l.liability_type === 'car_loan' ? '🚗' : l.liability_type === 'credit_card' ? '💳' : l.liability_type === 'student_loan' ? '🎓' : '📄'}
                  </div>
                  <div className="h-body">
                    <div className="h-name">{l.name || t.liabilityTypes[l.liability_type]}</div>
                    <div className="h-meta">
                      <span className="h-ticker">{l.interest_rate}%</span>
                      {l.monthly_payment > 0 && <span className="h-div-badge" style={{ color: 'var(--red)', background: 'var(--red-bg)' }}>月付 {sym}{Number(l.monthly_payment).toLocaleString()}</span>}
                    </div>
                    {l.total_amount > 0 && (
                      <div style={{ marginTop: 4, height: 3, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: progress + '%', background: 'var(--green)', borderRadius: 2, transition: 'width .3s' }} />
                      </div>
                    )}
                  </div>
                  <div className="h-right">
                    <div className="h-value" style={{ color: 'var(--red)' }}>-{fmtMoney(l.remaining_amount, sym)}</div>
                    {l.total_amount > 0 && <div className="h-pct">{progress.toFixed(0)}% 已還</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {tab === 'advisor' && (
        <div className="fade-up">
          <div className="section-header"><h2>{t.ruleBasedTitle}</h2></div>
          <div className="advice-list">
            {ruleAdvice.map((a, i) => <div key={i} className={`advice-card ${a.type}`}>{a.text}</div>)}
          </div>
          <div className="section-header"><h2>{t.aiAdvisor}</h2></div>
          <div style={{ padding: '0 16px 12px' }}>
            <button className="btn-primary" onClick={getAiAdvice} disabled={aiLoading}>
              {aiLoading ? t.analyzing : `${t.getAdvice} (${AI_DAILY_LIMIT - getAiUsageCount()}/${AI_DAILY_LIMIT})`}</button>
          </div>
          {aiResult && <div className="ai-box" dangerouslySetInnerHTML={{ __html: renderMarkdown(aiResult) }} />}
        </div>
      )}

      {/* ─── Settings Tab ─── */}
      {tab === 'settings' && (
        <div className="fade-up" style={{ padding: '16px 20px' }}>
          <div className="sheet-title">{t.settings}</div>
          <div className="setting-group">
            <div className="setting-label">USD/TWD</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '.9rem' }}>{usdTwd.toFixed(2)}</div>
          </div>
          {user && (
            <div className="setting-group">
              <div className="user-card">
                <div className="user-avatar">{(user.email || 'D')[0].toUpperCase()}</div>
                <div className="user-info">
                  <div className="name">{user.email}</div>
                  <div className="hint">{portfolio.items.length} {t.holdings}</div>
                </div>
              </div>
              {!isDemoMode && (
                <button className="btn-outline" style={{ marginTop: 10 }} onClick={async () => {
                  await supabase.auth.signOut()
                }}>{t.logout}</button>
              )}
            </div>
          )}
        </div>
      )}

      {/* FAB — show on holdings and dashboard */}
      {(tab === 'dashboard' || tab === 'holdings') && (
        <button className="fab" onClick={() => { setEditingItem(null); setShowForm(true) }}>+</button>
      )}

      {/* Bottom Tab Bar */}
      <div className="tab-bar">
        {[
          { id: 'dashboard', icon: '📊', label: t.dashboard },
          { id: 'holdings', icon: '💼', label: t.holdings },
          { id: 'advisor', icon: '🤖', label: t.advisor },
          { id: 'settings', icon: '⚙️', label: t.settings },
        ].map(tb => (
          <button key={tb.id} className={`tab ${tab === tb.id ? 'active' : ''}`} onClick={() => setTab(tb.id)}>
            <span className="tab-icon">{tb.icon}</span>
            <span className="tab-label">{tb.label}</span>
          </button>
        ))}
      </div>

      {/* ─── Sheets ─── */}
      <div className={`overlay ${showForm ? 'open' : ''}`} onClick={() => { setShowForm(false); setEditingItem(null) }} />
      <div className={`sheet ${showForm ? 'open' : ''}`}>
        <div className="sheet-handle" />
        {showForm && <SmartForm key={editingItem?.id || 'new'} t={t} item={editingItem} onSave={handleSave} onDelete={id => setConfirmDelete({ type: 'holding', id })}
          onCancel={() => { setShowForm(false); setEditingItem(null) }}
          onShowDividends={(item) => { setShowForm(false); setEditingItem(null); setShowHoldingDetail(item) }}
          dividendCount={editingItem ? dividends.filter(d => d.holding_id === editingItem.id).length : 0} />}
      </div>

      <div className={`overlay ${showHoldingDetail ? 'open' : ''}`} onClick={() => setShowHoldingDetail(null)} />
      <div className={`sheet ${showHoldingDetail ? 'open' : ''}`}>
        <div className="sheet-handle" />
        {showHoldingDetail && <HoldingDividends t={t} holding={showHoldingDetail}
          dividends={dividends.filter(d => d.holding_id === showHoldingDetail.id)}
          onAddDividend={() => { setDivFormHolding(showHoldingDetail); setShowDivForm(true) }}
          onDeleteDividend={handleDeleteDividend} onClose={() => setShowHoldingDetail(null)} />}
      </div>

      <div className={`overlay ${showDivForm ? 'open' : ''}`} onClick={() => { setShowDivForm(false); setDivFormHolding(null) }} />
      <div className={`sheet ${showDivForm ? 'open' : ''}`}>
        <div className="sheet-handle" />
        {divFormHolding && <DividendForm t={t} holding={divFormHolding}
          onSave={handleSaveDividend} onBatchSave={handleBatchDividends}
          onCancel={() => { setShowDivForm(false); setDivFormHolding(null) }} />}
      </div>

      {/* Liability Form */}
      <div className={`overlay ${showLiabForm ? 'open' : ''}`} onClick={() => { setShowLiabForm(false); setEditingLiab(null) }} />
      <div className={`sheet ${showLiabForm ? 'open' : ''}`}>
        <div className="sheet-handle" />
        {showLiabForm && <LiabilityForm key={editingLiab?.id || 'new-liab'} t={t} item={editingLiab} onSave={handleSaveLiability}
          onDelete={id => setConfirmDelete({ type: 'liability', id })}
          onCancel={() => { setShowLiabForm(false); setEditingLiab(null) }} />}
      </div>

      {confirmDelete && (
        <div className="confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-box" onClick={e => e.stopPropagation()}>
            <p>{confirmDelete.type === 'liability' ? t.confirmDeleteLiab : t.confirmDelete}</p>
            <div className="confirm-actions">
              <button className="no" onClick={() => setConfirmDelete(null)}>{t.no}</button>
              <button className="yes" onClick={() => {
                if (confirmDelete.type === 'liability') handleDeleteLiability(confirmDelete.id)
                else handleDelete(confirmDelete.id)
              }}>{t.yes}</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  )
}

// ─── Mini Pie ───
function MiniPie({ title, data }) {
  if (!data.length) return null
  return (
    <div className="chart-box">
      <div className="chart-title">{title}</div>
      <ResponsiveContainer width="100%" height={110}>
        <PieChart><Pie data={data} dataKey="value" cx="50%" cy="50%" innerRadius={26} outerRadius={44} paddingAngle={2} strokeWidth={0}>
          {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
        </Pie><Tooltip formatter={v => fmtMoney(v, 'NT$')}
          contentStyle={{ background: '#2a2a52', border: '1px solid rgba(255,255,255,.15)', borderRadius: 10, fontSize: '.78rem', color: '#fff', boxShadow: '0 4px 20px rgba(0,0,0,.5)' }}
          itemStyle={{ color: '#fff' }} labelStyle={{ color: '#b0b0cc', fontWeight: 500 }} /></PieChart>
      </ResponsiveContainer>
      <div className="chart-legend">{data.map((d, i) => (
        <div key={i} className="legend-item"><div className="legend-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />{d.name}</div>
      ))}</div>
    </div>
  )
}

// ─── Trend Chart ───
function TrendChart({ t, data, period, setPeriod }) {
  if (data.length < 2) return null
  const periods = ['7d', '30d', '90d', 'all']
  const first = data[0]?.value || 0, last = data[data.length - 1]?.value || 0
  const change = last - first, isUp = change >= 0
  return (
    <div className="trend-box s2 fade-up">
      <div className="trend-header">
        <div>
          <div className="trend-title">{t.trendChart}</div>
          <div className="trend-change" style={{ color: isUp ? 'var(--green)' : 'var(--red)' }}>
            {isUp ? '+' : ''}{fmtMoney(change, 'NT$')} ({isUp ? '+' : ''}{first > 0 ? (change / first * 100).toFixed(1) : '0'}%)
          </div>
        </div>
        <div className="period-tabs">{periods.map(p => (
          <button key={p} className={`period-tab ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>{t.period[p]}</button>
        ))}</div>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={data} margin={{ top: 4, right: 6, left: 6, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.04)" />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#5e5e80' }} tickLine={false} axisLine={false}
            interval={Math.max(0, Math.floor(data.length / 5) - 1)} />
          <YAxis hide />
          <Tooltip contentStyle={{ background: '#2a2a52', border: '1px solid rgba(255,255,255,.15)', borderRadius: 10, fontSize: '.78rem', color: '#fff', boxShadow: '0 4px 20px rgba(0,0,0,.5)' }}
            itemStyle={{ color: '#fff' }} labelStyle={{ color: '#b0b0cc', fontWeight: 500 }}
            formatter={v => [fmtMoney(v, 'NT$'), t.totalValue]} labelFormatter={(l, p) => p?.[0]?.payload?.fullDate || l} />
          <Line type="monotone" dataKey="value" stroke={isUp ? '#2dd4bf' : '#f472b6'} strokeWidth={2} dot={false} activeDot={{ r: 3.5 }} />
          <Line type="monotone" dataKey="cost" stroke="#5e5e80" strokeWidth={1} strokeDasharray="4 4" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Smart Form (simplified) ───
function SmartForm({ t, item, onSave, onDelete, onCancel, onShowDividends, dividendCount }) {
  const [mode, setMode] = useState(item?.market === 'cash' ? 'cash' : 'stock')
  const [ticker, setTicker] = useState(item?.ticker?.replace('.TW', '') || '')
  const [name, setName] = useState(item?.name || '')
  const [shares, setShares] = useState(item?.shares?.toString() || '')
  const [avgCost, setAvgCost] = useState(item?.avg_cost?.toString() || '')
  const [currentNav, setCurrentNav] = useState(item?.asset_type === 'fund' && item?.amount > 0 ? item.amount.toString() : '')
  const [amount, setAmount] = useState(item?.amount?.toString() || '')
  const [currency, setCurrency] = useState(item?.currency || 'TWD')
  const [assetType, setAssetType] = useState(item?.asset_type || 'stock')
  const [interestRate, setInterestRate] = useState(item?.interest_rate?.toString() || '')
  const [buyDate, setBuyDate] = useState(item?.buy_date || today())
  const [note, setNote] = useState(item?.note || '')

  const isFund = assetType === 'fund'
  const detectedMarket = isFund ? null : detectMarket(ticker)
  const cashTypes = ['cash', 'deposit', 'bond']

  useEffect(() => {
    if (mode === 'stock' && !isFund) {
      if (detectedMarket === 'tw') setCurrency('TWD')
      else if (detectedMarket === 'us') setCurrency('USD')
    }
  }, [ticker, mode, isFund])

  const handleSubmit = () => {
    if (mode === 'cash') {
      if (!amount || Number(amount) <= 0) return
      onSave({ ...(item?.id ? { id: item.id } : {}), market: 'cash', asset_type: assetType,
        ticker: '', name: name || t.assetTypes[assetType], shares: 0, avg_cost: 0,
        amount: Number(amount), currency, interest_rate: Number(interestRate) || 0, buy_date: buyDate, note })
    } else if (isFund) {
      // Fund: name required, ticker optional, amount stores current NAV
      if (!name || !shares || !avgCost) return
      const market = currency === 'TWD' ? 'tw' : 'us'
      onSave({ ...(item?.id ? { id: item.id } : {}), market, asset_type: 'fund',
        ticker: ticker ? ticker.toUpperCase() : '', name,
        shares: Number(shares), avg_cost: Number(avgCost),
        amount: Number(currentNav) || 0, currency, interest_rate: 0, buy_date: buyDate, note })
    } else {
      // Stock / ETF
      if (!ticker || !shares || !avgCost) return
      const market = detectedMarket || 'us'
      const tickerFmt = market === 'tw' && !ticker.includes('.') ? `${ticker}.TW` : ticker.toUpperCase()
      onSave({ ...(item?.id ? { id: item.id } : {}), market, asset_type: assetType === 'cash' ? 'stock' : assetType,
        ticker: tickerFmt, name, shares: Number(shares), avg_cost: Number(avgCost),
        amount: 0, currency, interest_rate: 0, buy_date: buyDate, note })
    }
  }

  return (
    <div>
      <div className="sheet-title">{item ? t.editHolding : t.addHolding}</div>

      {/* Stock vs Cash toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`type-chip ${mode === 'stock' ? 'active' : ''}`} style={{ flex: 1, textAlign: 'center' }}
          onClick={() => { setMode('stock'); if (cashTypes.includes(assetType)) setAssetType('stock') }}>📈 {t.markets.us} / {t.markets.tw}</button>
        <button className={`type-chip ${mode === 'cash' ? 'active' : ''}`} style={{ flex: 1, textAlign: 'center' }}
          onClick={() => { setMode('cash'); setAssetType('cash') }}>💵 {t.markets.cash}</button>
      </div>

      {mode === 'stock' ? (
        <>
          {/* Type chips — moved to top so fund mode changes the form below */}
          <div className="form-group">
            <div className="type-chips">
              {['stock', 'etf', 'fund'].map(tp => (
                <button key={tp} className={`type-chip ${assetType === tp ? 'active' : ''}`}
                  onClick={() => setAssetType(tp)}>{t.assetTypes[tp]}</button>
              ))}
            </div>
          </div>

          {isFund ? (
            /* ─── Fund Mode ─── */
            <>
              <div className="form-group">
                <label className="form-label">{t.name} *</label>
                <input className="form-input" placeholder={t.fundNameHint} value={name}
                  onChange={e => setName(e.target.value)} />
              </div>

              <div className="form-group">
                <label className="form-label">{t.ticker}（{t.optional}）</label>
                <input className="form-input" placeholder={t.fundTickerHint} value={ticker}
                  onChange={e => setTicker(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
                <div className="form-hint">{t.fundTickerDesc}</div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t.fundUnits}</label>
                  <input className="form-input" type="number" inputMode="decimal" placeholder="467289" value={shares}
                    onChange={e => setShares(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t.currency}</label>
                  <select className="form-input" value={currency} onChange={e => setCurrency(e.target.value)}>
                    <option value="TWD">TWD（台幣計價）</option>
                    <option value="USD">USD（美元計價）</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t.fundAvgNav}</label>
                  <input className="form-input" type="number" inputMode="decimal" placeholder="6.54" value={avgCost}
                    onChange={e => setAvgCost(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t.fundCurrentNav}</label>
                  <input className="form-input" type="number" inputMode="decimal" placeholder="7.12" value={currentNav}
                    onChange={e => setCurrentNav(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
                  <div className="form-hint">{t.fundNavHint}</div>
                </div>
              </div>

              {currentNav && avgCost && shares && (
                <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 14, fontSize: '.78rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text2)' }}>
                    <span>{t.cost}</span>
                    <span style={{ fontFamily: 'var(--mono)' }}>{fmtMoney(Number(shares) * Number(avgCost), CURRENCIES[currency]?.symbol || '$')}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text2)', marginTop: 4 }}>
                    <span>{t.totalValue}</span>
                    <span style={{ fontFamily: 'var(--mono)' }}>{fmtMoney(Number(shares) * Number(currentNav), CURRENCIES[currency]?.symbol || '$')}</span>
                  </div>
                  {(() => { const g = (Number(currentNav) - Number(avgCost)) * Number(shares); const gp = Number(avgCost) > 0 ? ((Number(currentNav) / Number(avgCost)) - 1) * 100 : 0
                    return <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, color: g >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      <span>{t.gain}</span>
                      <span style={{ fontFamily: 'var(--mono)' }}>{g >= 0 ? '+' : ''}{fmtMoney(g, CURRENCIES[currency]?.symbol || '$')} ({gp >= 0 ? '+' : ''}{gp.toFixed(1)}%)</span>
                    </div>
                  })()}
                </div>
              )}
            </>
          ) : (
            /* ─── Stock / ETF Mode ─── */
            <>
              <div className="form-group">
                <label className="form-label">{t.ticker}</label>
                <div className="ticker-wrapper">
                  <input className="form-input" placeholder={t.tickerHint} value={ticker}
                    onChange={e => setTicker(e.target.value.toUpperCase())}
                    style={{ fontFamily: 'var(--mono)', fontSize: '1rem', fontWeight: 600, paddingRight: 70 }} />
                  {detectedMarket && (
                    <span className={`detect-badge ${detectedMarket}`}>
                      {detectedMarket === 'tw' ? '🇹🇼 台股' : '🇺🇸 美股'}
                    </span>
                  )}
                </div>
                <div className="form-hint">{t.tickerHint} — {t.autoDetect}</div>
              </div>

              <div className="form-group">
                <label className="form-label">{t.name}（{t.optional}）</label>
                <input className="form-input" placeholder="Apple Inc." value={name} onChange={e => setName(e.target.value)} />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t.shares}</label>
                  <input className="form-input" type="number" inputMode="decimal" placeholder="100" value={shares}
                    onChange={e => setShares(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t.avgCost} ({currency})</label>
                  <input className="form-input" type="number" inputMode="decimal" placeholder="150.00" value={avgCost}
                    onChange={e => setAvgCost(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="form-group">
            <div className="type-chips">
              {cashTypes.map(tp => (
                <button key={tp} className={`type-chip ${assetType === tp ? 'active' : ''}`}
                  onClick={() => setAssetType(tp)}>{t.assetTypes[tp]}</button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">{t.name}</label>
            <input className="form-input" placeholder={t.assetTypes[assetType]} value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t.amount}</label>
              <input className="form-input" type="number" inputMode="decimal" value={amount}
                onChange={e => setAmount(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
            </div>
            <div className="form-group">
              <label className="form-label">{t.currency}</label>
              <select className="form-input" value={currency} onChange={e => setCurrency(e.target.value)}>
                <option value="TWD">TWD</option><option value="USD">USD</option>
              </select>
            </div>
          </div>
          {(assetType === 'deposit' || assetType === 'bond') && (
            <div className="form-group">
              <label className="form-label">{t.interestRate}</label>
              <input className="form-input" type="number" inputMode="decimal" value={interestRate}
                onChange={e => setInterestRate(e.target.value)} />
            </div>
          )}
        </>
      )}

      <div className="form-group">
        <label className="form-label">{t.buyDate}</label>
        <input className="form-input" type="date" value={buyDate} onChange={e => setBuyDate(e.target.value)} />
      </div>

      <button className="btn-primary" onClick={handleSubmit}>{t.save}</button>
      {item && (
        <button className="btn-outline" onClick={() => onShowDividends(item)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          🎁 {t.dividends} {dividendCount > 0 && `(${dividendCount})`}
        </button>
      )}
      {item && <button className="btn-danger" onClick={() => onDelete(item.id)}>🗑️ {t.delete}</button>}
      <button className="btn-outline" onClick={onCancel}>{t.cancel}</button>
    </div>
  )
}

// ─── Holding Dividends ───
function HoldingDividends({ t, holding, dividends, onAddDividend, onDeleteDividend, onClose }) {
  const sym = CURRENCIES[holding.currency]?.symbol || '$'
  const totalDiv = dividends.reduce((s, d) => s + (Number(d.total_amount) || 0), 0)
  return (
    <div>
      <div className="sheet-title">🎁 {t.divHistory}</div>
      <div style={{ textAlign: 'center', fontSize: '.82rem', color: 'var(--text2)', marginBottom: 14 }}>
        {holding.name || holding.ticker}</div>
      <div className="div-section">
        <div className="div-header">
          <h3>{t.dividends}</h3>
          <button className="div-add-btn" onClick={onAddDividend}>+ {t.addDividend}</button>
        </div>
        {dividends.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text3)', fontSize: '.82rem' }}>{t.noDividends}</div>
        ) : (<>
          {dividends.map(d => (
            <div className="div-item" key={d.id}>
              <div className="div-item-left">
                <span className="div-item-date">{d.div_date}</span>
                <span className="div-item-type">{t.divTypes[d.div_type] || d.div_type}
                  {d.per_share > 0 && ` · ${sym}${d.per_share}`}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="div-item-amount">{fmtMoney(d.total_amount, sym)}</span>
                <button className="div-item-del" onClick={e => { e.stopPropagation(); onDeleteDividend(d.id) }}>✕</button>
              </div>
            </div>
          ))}
          <div className="div-total-row"><span>{t.totalDividends}</span><span className="val">{fmtMoney(totalDiv, sym)}</span></div>
        </>)}
      </div>
      <button className="btn-outline" onClick={onClose}>{t.cancel}</button>
    </div>
  )
}

// ─── Dividend Form (with batch generation) ───
function DividendForm({ t, holding, onSave, onBatchSave, onCancel }) {
  const [formMode, setFormMode] = useState('single') // 'single' or 'batch'
  const [divDate, setDivDate] = useState(today())
  const [divType, setDivType] = useState('cash')
  const [perShare, setPerShare] = useState('')
  const [totalAmount, setTotalAmount] = useState('')
  const [autoCalc, setAutoCalc] = useState(true)
  // Batch fields
  const [frequency, setFrequency] = useState('monthly')
  const [batchFrom, setBatchFrom] = useState(() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10) })
  const [batchTo, setBatchTo] = useState(today())
  const [batchPerShare, setBatchPerShare] = useState('')
  const [batchTotal, setBatchTotal] = useState('')
  const [batchAutoCalc, setBatchAutoCalc] = useState(true)

  const sym = CURRENCIES[holding.currency]?.symbol || '$'

  useEffect(() => {
    if (autoCalc && perShare && holding.shares) setTotalAmount((Number(perShare) * Number(holding.shares)).toFixed(2))
  }, [perShare, autoCalc])

  useEffect(() => {
    if (batchAutoCalc && batchPerShare && holding.shares) setBatchTotal((Number(batchPerShare) * Number(holding.shares)).toFixed(2))
  }, [batchPerShare, batchAutoCalc])

  // Generate batch dates
  const batchDates = useMemo(() => {
    if (formMode !== 'batch' || !batchFrom || !batchTo) return []
    const dates = []
    const start = new Date(batchFrom), end = new Date(batchTo)
    const monthStep = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : frequency === 'semi_annual' ? 6 : 12
    let cursor = new Date(start)
    while (cursor <= end) {
      dates.push(cursor.toISOString().slice(0, 10))
      cursor = new Date(cursor)
      cursor.setMonth(cursor.getMonth() + monthStep)
    }
    return dates
  }, [formMode, frequency, batchFrom, batchTo])

  const batchAmountPerEntry = Number(batchTotal) || (Number(batchPerShare) * Number(holding.shares)) || 0

  const handleSingleSubmit = () => {
    const total = Number(totalAmount); if (!total || total <= 0) return
    onSave({ holding_id: holding.id, div_date: divDate, div_type: divType,
      per_share: Number(perShare) || 0, total_amount: total, currency: holding.currency })
  }

  const handleBatchSubmit = () => {
    if (!batchDates.length || batchAmountPerEntry <= 0) return
    const divList = batchDates.map(date => ({
      holding_id: holding.id, div_date: date, div_type: divType,
      per_share: Number(batchPerShare) || 0, total_amount: batchAmountPerEntry, currency: holding.currency
    }))
    onBatchSave(divList)
  }

  return (
    <div>
      <div className="sheet-title">🎁 {t.addDividend}</div>
      <div style={{ textAlign: 'center', fontSize: '.82rem', color: 'var(--text2)', marginBottom: 14 }}>{holding.name || holding.ticker}</div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`type-chip ${formMode === 'single' ? 'active' : ''}`} style={{ flex: 1, textAlign: 'center' }}
          onClick={() => setFormMode('single')}>{t.divSingle}</button>
        <button className={`type-chip ${formMode === 'batch' ? 'active' : ''}`} style={{ flex: 1, textAlign: 'center' }}
          onClick={() => setFormMode('batch')}>{t.divBatch}</button>
      </div>

      {/* Div type */}
      <div className="form-group">
        <div className="type-chips">
          {['cash', 'stock', 'interest'].map(tp => (
            <button key={tp} className={`type-chip ${divType === tp ? 'active' : ''}`} onClick={() => setDivType(tp)}>{t.divTypes[tp]}</button>
          ))}
        </div>
      </div>

      {formMode === 'single' ? (
        <>
          <div className="form-group">
            <label className="form-label">{t.divDate}</label>
            <input className="form-input" type="date" value={divDate} onChange={e => setDivDate(e.target.value)} />
          </div>
          {holding.shares > 0 && (
            <div className="form-group">
              <label className="form-label">{t.divPerShare} ({sym})</label>
              <input className="form-input" type="number" inputMode="decimal" placeholder="0.82" value={perShare}
                onChange={e => { setPerShare(e.target.value); setAutoCalc(true) }} style={{ fontFamily: 'var(--mono)' }} />
              <div className="form-hint">× {Number(holding.shares).toLocaleString()} = {perShare ? fmtMoney(Number(perShare) * holding.shares, sym) : '-'}</div>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t.divTotal} ({sym})</label>
            <input className="form-input" type="number" inputMode="decimal" value={totalAmount}
              onChange={e => { setTotalAmount(e.target.value); setAutoCalc(false) }}
              style={{ fontFamily: 'var(--mono)', fontSize: '1.1rem', fontWeight: 600, textAlign: 'center' }} />
          </div>
          <button className="btn-primary" onClick={handleSingleSubmit}>{t.save}</button>
        </>
      ) : (
        <>
          {/* Frequency */}
          <div className="form-group">
            <label className="form-label">{t.divFrequency}</label>
            <div className="type-chips">
              {['monthly', 'quarterly', 'semi_annual', 'annual'].map(f => (
                <button key={f} className={`type-chip ${frequency === f ? 'active' : ''}`}
                  onClick={() => setFrequency(f)}>{t.frequencies[f]}</button>
              ))}
            </div>
          </div>

          {/* Date range */}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t.divBatchFrom}</label>
              <input className="form-input" type="date" value={batchFrom} onChange={e => setBatchFrom(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">{t.divBatchTo}</label>
              <input className="form-input" type="date" value={batchTo} onChange={e => setBatchTo(e.target.value)} />
            </div>
          </div>

          {/* Amount per entry */}
          {holding.shares > 0 && (
            <div className="form-group">
              <label className="form-label">{t.divPerShare} ({sym})</label>
              <input className="form-input" type="number" inputMode="decimal" placeholder="0.048" value={batchPerShare}
                onChange={e => { setBatchPerShare(e.target.value); setBatchAutoCalc(true) }} style={{ fontFamily: 'var(--mono)' }} />
              <div className="form-hint">× {Number(holding.shares).toLocaleString()} = {batchPerShare ? fmtMoney(Number(batchPerShare) * holding.shares, sym) : '-'}</div>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t.divAmountPerEntry} ({sym})</label>
            <input className="form-input" type="number" inputMode="decimal" value={batchTotal}
              onChange={e => { setBatchTotal(e.target.value); setBatchAutoCalc(false) }}
              style={{ fontFamily: 'var(--mono)', fontWeight: 600, textAlign: 'center' }} />
          </div>

          {/* Preview */}
          {batchDates.length > 0 && batchAmountPerEntry > 0 && (
            <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: 14, fontSize: '.78rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text2)', marginBottom: 6 }}>
                <span>{t.divBatchPreview}</span>
                <span style={{ color: 'var(--yellow)', fontFamily: 'var(--mono)', fontWeight: 600 }}>
                  {batchDates.length} {t.divBatchEntries} · {fmtMoney(batchAmountPerEntry * batchDates.length, sym)}
                </span>
              </div>
              <div style={{ maxHeight: 120, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                {batchDates.map((d, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text3)', fontSize: '.7rem', fontFamily: 'var(--mono)' }}>
                    <span>{d}</span>
                    <span style={{ color: 'var(--yellow)' }}>{fmtMoney(batchAmountPerEntry, sym)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button className="btn-primary" onClick={handleBatchSubmit} disabled={!batchDates.length || batchAmountPerEntry <= 0}>
            {t.divBatchGenerate} ({batchDates.length} {t.divBatchEntries})
          </button>
        </>
      )}

      <button className="btn-outline" onClick={onCancel}>{t.cancel}</button>
    </div>
  )
}

// ─── Liability Form ───
function LiabilityForm({ t, item, onSave, onDelete, onCancel }) {
  const [liabType, setLiabType] = useState(item?.liability_type || 'mortgage')
  const [name, setName] = useState(item?.name || '')
  const [totalAmount, setTotalAmount] = useState(item?.total_amount?.toString() || '')
  const [remainingAmount, setRemainingAmount] = useState(item?.remaining_amount?.toString() || '')
  const [interestRate, setInterestRate] = useState(item?.interest_rate?.toString() || '')
  const [monthlyPayment, setMonthlyPayment] = useState(item?.monthly_payment?.toString() || '')
  const [currency, setCurrency] = useState(item?.currency || 'TWD')
  const [startDate, setStartDate] = useState(item?.start_date || today())
  const [endDate, setEndDate] = useState(item?.end_date || '')
  const [note, setNote] = useState(item?.note || '')

  const types = ['mortgage', 'personal_loan', 'car_loan', 'credit_card', 'student_loan', 'other']
  const typeIcons = { mortgage: '🏠', personal_loan: '📄', car_loan: '🚗', credit_card: '💳', student_loan: '🎓', other: '📌' }

  const handleSubmit = () => {
    if (!remainingAmount || Number(remainingAmount) <= 0) return
    onSave({
      ...(item?.id ? { id: item.id } : {}),
      liability_type: liabType,
      name: name || t.liabilityTypes[liabType],
      total_amount: Number(totalAmount) || Number(remainingAmount),
      remaining_amount: Number(remainingAmount),
      interest_rate: Number(interestRate) || 0,
      monthly_payment: Number(monthlyPayment) || 0,
      currency, start_date: startDate, end_date: endDate || null, note
    })
  }

  return (
    <div>
      <div className="sheet-title">{item ? t.editLiability : t.addLiability}</div>

      <div className="form-group">
        <label className="form-label">{t.liabilityType}</label>
        <div className="type-chips">
          {types.map(tp => (
            <button key={tp} className={`type-chip ${liabType === tp ? 'active' : ''}`}
              onClick={() => setLiabType(tp)}>{typeIcons[tp]} {t.liabilityTypes[tp]}</button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">{t.name}</label>
        <input className="form-input" placeholder={t.liabilityTypes[liabType]} value={name}
          onChange={e => setName(e.target.value)} />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">{t.totalAmount}</label>
          <input className="form-input" type="number" inputMode="decimal" placeholder="5,000,000"
            value={totalAmount} onChange={e => setTotalAmount(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
        </div>
        <div className="form-group">
          <label className="form-label">{t.remainingAmount}</label>
          <input className="form-input" type="number" inputMode="decimal" placeholder="3,200,000"
            value={remainingAmount} onChange={e => setRemainingAmount(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">{t.interestRate}</label>
          <input className="form-input" type="number" inputMode="decimal" placeholder="2.1"
            value={interestRate} onChange={e => setInterestRate(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
        </div>
        <div className="form-group">
          <label className="form-label">{t.monthlyPayment}</label>
          <input className="form-input" type="number" inputMode="decimal" placeholder="18,000"
            value={monthlyPayment} onChange={e => setMonthlyPayment(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">{t.currency}</label>
          <select className="form-input" value={currency} onChange={e => setCurrency(e.target.value)}>
            <option value="TWD">TWD</option><option value="USD">USD</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">{t.startDate}</label>
          <input className="form-input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">{t.endDate}（{t.optional}）</label>
        <input className="form-input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
      </div>

      <div className="form-group">
        <label className="form-label">{t.note}</label>
        <input className="form-input" type="text" placeholder={t.note} value={note} onChange={e => setNote(e.target.value)} />
      </div>

      <button className="btn-primary" onClick={handleSubmit}>{t.save}</button>
      {item && <button className="btn-danger" onClick={() => onDelete(item.id)}>🗑️ {t.delete}</button>}
      <button className="btn-outline" onClick={onCancel}>{t.cancel}</button>
    </div>
  )
}

// ─── Auth Page ───
function AuthPage({ t }) {
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const handleAuth = async () => {
    setError(''); setLoading(true)
    try {
      const fn = isSignUp ? supabase.auth.signUp : supabase.auth.signInWithPassword
      const { error: err } = await fn.call(supabase.auth, { email, password })
      if (err) setError(err.message)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }
  return (
    <><style>{CSS}</style>
    <div className="auth-page">
      <div className="auth-logo">📊</div>
      <div className="auth-title">{t.appName}</div>
      <div className="auth-sub">{isSignUp ? t.signUp : t.signIn}</div>
      <div className="auth-form">
        <div className="form-group"><input className="form-input" type="email" placeholder={t.email} value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="form-group"><input className="form-input" type="password" placeholder={t.password} value={password}
          onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAuth()} /></div>
        <button className="btn-primary" onClick={handleAuth} disabled={loading}>{loading ? '...' : isSignUp ? t.signUp : t.signIn}</button>
        {error && <div className="auth-error">{error}</div>}
        <button className="auth-switch" onClick={() => setIsSignUp(!isSignUp)}>{isSignUp ? t.switchToSignIn : t.switchToSignUp}</button>
      </div>
    </div></>
  )
}

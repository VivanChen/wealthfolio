# 📊 WealthFolio 理財規劃

美股 + 台股 + 現金/定存/債券 投資組合管理工具，支援自動報價、圖表分析、AI 投資建議。

## 功能

- ✅ **美股/台股** 個股 + ETF，自動從 Yahoo Finance 取得即時報價
- ✅ **現金/定存/債券** 固定收益資產追蹤
- ✅ **儀表板** 圓餅圖（依市場/依類型）、總資產、總損益
- ✅ **損益追蹤** 每檔持倉的買入成本 vs 現價、報酬率
- ✅ **資產配置建議** 規則引擎自動分析股債比、集中度、分散度
- ✅ **AI 投資顧問** Claude API 深度分析投資組合並給予具體建議
- ✅ **多幣別** 自動抓取 USD/TWD 匯率換算
- ✅ **匯出 Excel** 一鍵匯出持倉明細
- ✅ **多人同步** Supabase Realtime
- ✅ **多語言** 繁體中文 + 印尼文

## 架構

```
Netlify CDN (React)  ←→  Supabase (PostgreSQL + Auth + Realtime)
       ↕
Netlify Functions
  ├── /api/stock-price   → Yahoo Finance API (美股+台股報價)
  └── /api/ai-advice     → Claude API (AI 投資建議)
```

## 部署

### 1. Supabase
1. 到 supabase.com 建立專案
2. SQL Editor 執行 `supabase-schema.sql`
3. Authentication > Users 新增使用者

### 2. Netlify
1. 推到 GitHub
2. Netlify 連結 repo
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `ANTHROPIC_API_KEY`（可選，啟用 AI 顧問）

### 本地開發

```bash
npm install
cp .env.example .env  # 填入 Supabase 設定
npm run dev
```

> 不設定 Supabase 會進入 Demo 模式（localStorage）
> 股票報價需部署到 Netlify 後才能使用（需要 serverless function）

## 使用方式

1. **新增資產** - 點 + 按鈕，選擇市場（美股/台股/現金），輸入股票代號、股數、成本
2. **自動報價** - 系統自動取得即時價格，計算損益
3. **查看配置** - 儀表板顯示資產配置圓餅圖
4. **取得建議** - 點 🤖 按鈕查看規則建議 + AI 深度分析
5. **匯出報表** - 點 📥 匯出 Excel

## 股票代號格式

| 市場 | 格式 | 範例 |
|------|------|------|
| 美股 | 直接輸入 | `AAPL`, `MSFT`, `VOO` |
| 台股 | 代號.TW | `2330.TW`, `0050.TW` |

> 台股輸入純數字（如 `2330`）會自動加上 `.TW`

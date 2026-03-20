-- ================================================
-- WealthFolio 理財規劃 - Supabase 資料庫設定
-- 在 Supabase Dashboard > SQL Editor 中執行
-- ================================================

CREATE TABLE holdings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('us', 'tw', 'cash')),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'etf', 'cash', 'deposit', 'bond')),
  ticker TEXT DEFAULT '',
  name TEXT DEFAULT '',
  shares NUMERIC DEFAULT 0,
  avg_cost NUMERIC DEFAULT 0,
  amount NUMERIC DEFAULT 0,
  currency TEXT DEFAULT 'TWD',
  interest_rate NUMERIC DEFAULT 0,
  buy_date DATE DEFAULT CURRENT_DATE,
  note TEXT DEFAULT '',
  note_lang TEXT DEFAULT 'zh-TW',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_holdings_user ON holdings (user_email);

ALTER TABLE holdings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "只能檢視自己的" ON holdings
  FOR SELECT USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "只能新增自己的" ON holdings
  FOR INSERT WITH CHECK (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可修改" ON holdings
  FOR UPDATE USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可刪除" ON holdings
  FOR DELETE USING (auth.jwt() ->> 'email' = user_email);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_holdings
  BEFORE UPDATE ON holdings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER PUBLICATION supabase_realtime ADD TABLE holdings;

-- ================================================
-- Dividends / 配息紀錄
-- ================================================

CREATE TABLE dividends (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  holding_id UUID NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  div_date DATE NOT NULL DEFAULT CURRENT_DATE,
  div_type TEXT NOT NULL DEFAULT 'cash' CHECK (div_type IN ('cash', 'stock', 'interest')),
  per_share NUMERIC DEFAULT 0,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'TWD',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dividends_holding ON dividends (holding_id);
CREATE INDEX idx_dividends_user ON dividends (user_email);

ALTER TABLE dividends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "只能檢視自己的配息" ON dividends
  FOR SELECT USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "只能新增自己的配息" ON dividends
  FOR INSERT WITH CHECK (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可修改配息" ON dividends
  FOR UPDATE USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可刪除配息" ON dividends
  FOR DELETE USING (auth.jwt() ->> 'email' = user_email);

ALTER PUBLICATION supabase_realtime ADD TABLE dividends;

-- ================================================
-- Snapshots / 資產快照（走勢圖用）
-- ================================================

CREATE TABLE snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT NOT NULL,
  snap_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_value_twd NUMERIC NOT NULL DEFAULT 0,
  total_cost_twd NUMERIC NOT NULL DEFAULT 0,
  total_div_twd NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_email, snap_date)
);

CREATE INDEX idx_snapshots_user_date ON snapshots (user_email, snap_date);

ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "只能檢視自己的快照" ON snapshots
  FOR SELECT USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "只能新增自己的快照" ON snapshots
  FOR INSERT WITH CHECK (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可修改快照" ON snapshots
  FOR UPDATE USING (auth.jwt() ->> 'email' = user_email);

ALTER PUBLICATION supabase_realtime ADD TABLE snapshots;

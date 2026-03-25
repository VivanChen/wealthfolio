-- ================================================
-- WealthFolio 理財規劃 - Supabase 資料庫設定
-- 在 Supabase Dashboard > SQL Editor 中執行
-- ================================================

CREATE TABLE holdings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('us', 'tw', 'cash')),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'etf', 'fund', 'cash', 'deposit', 'bond')),
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

-- ================================================
-- Liabilities / 負債
-- ================================================

CREATE TABLE liabilities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT NOT NULL,
  liability_type TEXT NOT NULL CHECK (liability_type IN ('mortgage', 'personal_loan', 'car_loan', 'credit_card', 'student_loan', 'other')),
  name TEXT NOT NULL DEFAULT '',
  total_amount NUMERIC NOT NULL DEFAULT 0,
  remaining_amount NUMERIC NOT NULL DEFAULT 0,
  interest_rate NUMERIC DEFAULT 0,
  monthly_payment NUMERIC DEFAULT 0,
  currency TEXT DEFAULT 'TWD',
  start_date DATE DEFAULT CURRENT_DATE,
  end_date DATE,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_liabilities_user ON liabilities (user_email);

ALTER TABLE liabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "只能檢視自己的負債" ON liabilities
  FOR SELECT USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "只能新增自己的負債" ON liabilities
  FOR INSERT WITH CHECK (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可修改負債" ON liabilities
  FOR UPDATE USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可刪除負債" ON liabilities
  FOR DELETE USING (auth.jwt() ->> 'email' = user_email);

CREATE TRIGGER trigger_update_liabilities
  BEFORE UPDATE ON liabilities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER PUBLICATION supabase_realtime ADD TABLE liabilities;

-- ================================================
-- Monthly Budget / 每月收支
-- ================================================

CREATE TABLE monthly_budget (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'TWD',
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_budget_user ON monthly_budget (user_email);

ALTER TABLE monthly_budget ENABLE ROW LEVEL SECURITY;

CREATE POLICY "只能檢視自己的收支" ON monthly_budget
  FOR SELECT USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "只能新增自己的收支" ON monthly_budget
  FOR INSERT WITH CHECK (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可修改收支" ON monthly_budget
  FOR UPDATE USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "建立者可刪除收支" ON monthly_budget
  FOR DELETE USING (auth.jwt() ->> 'email' = user_email);

CREATE TRIGGER trigger_update_budget
  BEFORE UPDATE ON monthly_budget
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER PUBLICATION supabase_realtime ADD TABLE monthly_budget;

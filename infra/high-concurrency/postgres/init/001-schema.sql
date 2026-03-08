CREATE TABLE IF NOT EXISTS regional_check_results (
  id BIGSERIAL PRIMARY KEY,
  worker_id TEXT NOT NULL,
  region TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_regional_check_results_region_created
  ON regional_check_results (region, created_at DESC);

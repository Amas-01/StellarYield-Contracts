-- Issue #1104: unified fee ledger for fee revenue charts.
-- Every fee the platform collects, one row per collection:
--   * operator fees taken on yield distributions (indexed_events.parsed_data)
--   * early-redemption fees (redemption_requests.fee_revenue)
-- Kept as a view so it always reflects the indexed source tables.

CREATE OR REPLACE VIEW transfer_fees AS
  SELECT ie.contract_id,
         'operator_fee'::text AS fee_type,
         (ie.parsed_data->>'operatorFee')::numeric AS fee_amount,
         ie.created_at AS collected_at
  FROM indexed_events ie
  WHERE ie.event_type = 'yield_distributed'
    AND ie.parsed_data ? 'operatorFee'
  UNION ALL
  SELECT v.contract_id,
         'early_redemption_fee'::text AS fee_type,
         rr.fee_revenue AS fee_amount,
         rr.request_time AS collected_at
  FROM redemption_requests rr
  JOIN vaults v ON v.id = rr.vault_id
  WHERE rr.processed = TRUE
    AND rr.fee_revenue > 0;

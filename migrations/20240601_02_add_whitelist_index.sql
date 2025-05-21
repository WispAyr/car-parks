-- Migration: Add index for fast lookup by carParkId and VRM
CREATE INDEX idx_whitelist_carParkId_VRM ON whitelist(carParkId, VRM); 
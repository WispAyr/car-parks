-- Add processed flag to anpr_detections table
ALTER TABLE anpr_detections
ADD COLUMN processed BOOLEAN DEFAULT FALSE,
ADD COLUMN processed_at TIMESTAMP NULL; 
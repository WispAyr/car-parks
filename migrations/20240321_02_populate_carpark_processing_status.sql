-- Insert initial data for existing car parks
INSERT INTO carpark_processing_status (siteId, isEnabled)
SELECT siteId, true FROM carparks
WHERE NOT EXISTS (
    SELECT 1 FROM carpark_processing_status cps 
    WHERE cps.siteId = carparks.siteId
); 
-- Remove the short-lived staff promotion feature after confirming it has no records.
DELETE FROM public.site_settings WHERE key = 'promotionChannelId';

DROP FUNCTION IF EXISTS public.record_staff_promotion(
  text,text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,text
);
DROP TABLE IF EXISTS public.staff_promotions;

NOTIFY pgrst, 'reload schema';

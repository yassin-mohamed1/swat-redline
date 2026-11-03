-- The website uses server-side Vercel routes; browser roles do not need direct table access.
revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

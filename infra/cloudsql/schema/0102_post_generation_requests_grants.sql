-- infra/cloudsql/schema/0102_post_generation_requests_grants.sql
-- Repair already-applied systems where 0100 created the durable post generation
-- request table but the application role did not inherit privileges for it.

grant select, insert, update, delete on noelle.post_generation_requests to noelle_app;

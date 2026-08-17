-- Revoke every live session for one auth user. Called by the service-role
-- client only (admin archive, purge and password-reset routes). This is the
-- real replacement for auth.admin.signOut(uuid), which is a no-op because
-- auth-js sends arg 1 as the Bearer JWT, not a user id (verified 16 Aug 2026).
-- Deleting auth.sessions evicts on the next request (GoTrue validates the
-- JWT session_id claim against auth.sessions); deleting auth.refresh_tokens
-- kills refresh. Live-verified 17 Aug 2026: open session bounced to login
-- on next click.
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
  v_count integer;
BEGIN
  -- refresh_tokens.user_id is varchar in the auth schema, hence the cast.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text;
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO service_role;
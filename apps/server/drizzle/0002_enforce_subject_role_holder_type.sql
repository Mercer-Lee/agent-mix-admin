CREATE OR REPLACE FUNCTION "agentmix_enforce_subject_type_update"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."type" IS DISTINCT FROM OLD."type" THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'subjects.type is immutable';
	END IF;
	RETURN NEW;
END;
$$;

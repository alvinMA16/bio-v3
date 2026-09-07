-- Read-only, bounded extraction. No user UUIDs, names from profiles, audio or future turns.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
WITH sessions AS (
 SELECT c.id, dense_rank() OVER (ORDER BY c.created_at,c.id) AS session_group,
 dense_rank() OVER (ORDER BY c.user_id) AS user_group
 FROM conversations c WHERE c.deleted_at IS NULL AND c.mode='normal'
 AND EXISTS (SELECT 1 FROM conversation_turn_diagnostics d WHERE d.conversation_id=c.id AND d.user_text_source='final')
), numbered AS (
 SELECT m.*,s.session_group,s.user_group,
 row_number() OVER(PARTITION BY m.conversation_id ORDER BY m.created_at,m.id) AS position,
 count(*) FILTER(WHERE m.role='user') OVER(PARTITION BY m.conversation_id ORDER BY m.created_at,m.id) AS user_turn
 FROM messages m JOIN sessions s ON s.id=m.conversation_id
), selected AS (
 SELECT * FROM numbered WHERE role='user'
 AND ((session_group=1 AND user_turn IN (2,7,20,40)) OR (session_group<>1 AND user_turn IN (1,2,3)))
 ORDER BY session_group,user_turn LIMIT 20
)
SELECT json_build_object('id','real-'||lpad(s.session_group::text,2,'0')||'-'||lpad(s.user_turn::text,2,'0'),
 'session_group',s.session_group,'user_group',s.user_group,'user_turn',s.user_turn,
 'history_omitted',s.position>5,
 'voice_evidence','session_has_final_asr_diagnostic',
 'messages',(SELECT json_agg(json_build_object('role',p.role,'content',p.content) ORDER BY p.position)
 FROM numbered p WHERE p.conversation_id=s.conversation_id AND p.position BETWEEN greatest(1,s.position-4) AND s.position))
FROM selected s ORDER BY s.session_group,s.user_turn;
ROLLBACK;

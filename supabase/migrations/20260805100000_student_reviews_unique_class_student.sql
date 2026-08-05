-- 20260805100000_student_reviews_unique_class_student.sql
-- Applied live via SQL Editor 5 Aug 2026 (S483)
-- Prevents duplicate reviews per (class_id, student_id); route handles 23505 as 409

alter table public.student_reviews
add constraint student_reviews_class_student_unique unique (class_id, student_id);

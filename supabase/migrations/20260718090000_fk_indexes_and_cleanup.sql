-- Applied live via SQL Editor 18 Jul 2026; recorded here for migration truthfulness.
-- 34 FK covering indexes from Supabase advisor (Disk IO session).
-- Skipped intentionally: exercises (table dies in NEW345 step 7), reviews (parked for drop).
-- Also: purge dead pg_cron history (job deleted 8 Jul) and drop a leftover
-- backup table from a past fix session (verified unreferenced, 6 rows of test data).
create index if not exists idx_students_company_id on public.students (company_id);
create index if not exists idx_students_auth_user_id on public.students (auth_user_id);
create index if not exists idx_trainings_student_id on public.trainings (student_id);
create index if not exists idx_trainings_teacher_id on public.trainings (teacher_id);
create index if not exists idx_training_teachers_teacher_id on public.training_teachers (teacher_id);
create index if not exists idx_lessons_training_id on public.lessons (training_id);
create index if not exists idx_study_sheets_owner_id on public.study_sheets (owner_id);
create index if not exists idx_assignments_assigned_by on public.assignments (assigned_by);
create index if not exists idx_assignments_lesson_id on public.assignments (lesson_id);
create index if not exists idx_assignments_student_id on public.assignments (student_id);
create index if not exists idx_assignments_study_sheet_id on public.assignments (study_sheet_id);
create index if not exists idx_classes_student_id on public.classes (student_id);
create index if not exists idx_classes_teacher_id on public.classes (teacher_id);
create index if not exists idx_classes_training_id on public.classes (training_id);
create index if not exists idx_exercise_completions_assignment_id on public.exercise_completions (assignment_id);
create index if not exists idx_exercise_completions_sheet_id on public.exercise_completions (sheet_id);
create index if not exists idx_student_reviews_class_id on public.student_reviews (class_id);
create index if not exists idx_student_reviews_student_id on public.student_reviews (student_id);
create index if not exists idx_student_reviews_teacher_id on public.student_reviews (teacher_id);
create index if not exists idx_hours_log_created_by on public.hours_log (created_by);
create index if not exists idx_hours_log_lesson_id on public.hours_log (lesson_id);
create index if not exists idx_hours_log_student_id on public.hours_log (student_id);
create index if not exists idx_announcements_created_by on public.announcements (created_by);
create index if not exists idx_admin_tasks_assigned_to on public.admin_tasks (assigned_to);
create index if not exists idx_admin_tasks_created_by on public.admin_tasks (created_by);
create index if not exists idx_teacher_history_log_changed_by on public.teacher_history_log (changed_by);
create index if not exists idx_teacher_history_log_teacher_id on public.teacher_history_log (teacher_id);
create index if not exists idx_export_log_exported_by on public.export_log (exported_by);
create index if not exists idx_sheet_tags_tag_id on public.sheet_tags (tag_id);
create index if not exists idx_activities_sheet_id on public.activities (sheet_id);
create index if not exists idx_activity_attempts_activity_id on public.activity_attempts (activity_id);
create index if not exists idx_activity_attempts_assignment_id on public.activity_attempts (assignment_id);
create index if not exists idx_activity_attempts_reviewed_by on public.activity_attempts (reviewed_by);
create index if not exists idx_activity_attempts_student_id on public.activity_attempts (student_id);
truncate table cron.job_run_details;
drop table if exists public._backup_fake_completed_s151;

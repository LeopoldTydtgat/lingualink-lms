import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();

  // Confirm the user is authenticated
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  // Resolve the authoritative student id from the session — never trust the body
  const { data: studentRow } = await supabase
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (!studentRow) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const studentId = studentRow.id;

  const body = await request.json();
  const { class_id, teacher_id, rating, review_text } = body;

  // Basic validation
  if (!class_id || !teacher_id || !rating) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  if (rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'Rating must be between 1 and 5' }, { status: 400 });
  }

  // Confirm the lesson belongs to this student — prevents spoofing another student's class_id
  const { data: lesson } = await supabase
    .from('lessons')
    .select('id')
    .eq('id', class_id)
    .eq('student_id', studentId)
    .single();

  if (!lesson) {
    return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  }

  // Check a review doesn't already exist for this class
  const { data: existing } = await supabase
    .from('student_reviews')
    .select('id')
    .eq('class_id', class_id)
    .eq('student_id', studentId)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: 'You have already reviewed this class' }, { status: 409 });
  }

  // Insert the review
  const { error } = await supabase
    .from('student_reviews')
    .insert({
      class_id,
      student_id: studentId,
      teacher_id,
      rating,
      review_text: review_text ?? null,
    });

  if (error) {
    console.error('Review insert error:', error);
    return NextResponse.json({ error: 'Failed to save review' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

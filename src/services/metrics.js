// Performance categories are reported separately and never merged into a single score.

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

export function studentMetrics(db, studentId) {
  const answers = db.prepare(
    `SELECT sa.word_accuracy, sa.exact_match, sa.couldnt_catch, sa.answer_text, ia.familiarity_at_start,
            ia.playback_start_count, ia.playback_completed_count, t.mode, t.id AS test_id
       FROM submitted_answers sa
       JOIN item_attempts ia ON ia.id = sa.item_attempt_id
       JOIN assessment_attempts a ON a.id = sa.attempt_id
       JOIN tests t ON t.id = a.test_id
      WHERE sa.student_id = ? AND a.status = 'submitted' AND a.attempt_kind = 'independent'`
  ).all(studentId);
  const attempts = db.prepare(
    `SELECT a.*, t.number, t.title, t.mode FROM assessment_attempts a JOIN tests t ON t.id = a.test_id
      WHERE a.student_id = ? AND a.status = 'submitted' AND a.attempt_kind = 'independent' ORDER BY a.submitted_at`
  ).all(studentId);
  // Practice retakes: reported on their own, never mixed into the independent score.
  const practice = db.prepare(
    `SELECT a.test_id, AVG(sa.word_accuracy) AS acc FROM assessment_attempts a JOIN submitted_answers sa ON sa.attempt_id = a.id
      WHERE a.student_id = ? AND a.status = 'submitted' AND a.attempt_kind = 'practice' GROUP BY a.id`
  ).all(studentId);
  const freePractice = db.prepare('SELECT exact_match FROM review_practice WHERE student_id = ?').pluck().all(studentId);
  const reviewAttempts = db.prepare(
    `SELECT ra.* FROM review_attempts ra JOIN review_items ri ON ri.id = ra.review_item_id WHERE ri.student_id = ?`
  ).all(studentId);
  const reviewItems = db.prepare('SELECT * FROM review_items WHERE student_id = ?').all(studentId);

  const unseen = answers.filter((a) => a.familiarity_at_start === 'unseen');
  const familiar = answers.filter((a) => a.familiarity_at_start === 'previously_practised');
  const immediate = reviewAttempts.filter((r) => r.kind === 'immediate');
  const immediateDone = immediate.filter((r) => r.completed_at);
  const delayed = reviewAttempts.filter((r) => r.kind === 'delayed' && r.completed_at);
  const passedItems = reviewItems.filter((i) => i.status === 'delayed_passed');
  const originalByItem = new Map(
    db.prepare(
      `SELECT ri.id, sa.word_accuracy FROM review_items ri JOIN submitted_answers sa ON sa.item_attempt_id = ri.source_item_attempt_id
        WHERE ri.student_id = ?`
    ).all(studentId).map((r) => [r.id, r.word_accuracy])
  );

  return {
    testsCompleted: attempts.length,
    independent: {
      sentences: answers.length,
      wordAccuracy: avg(answers.map((a) => a.word_accuracy)),
      exactSentenceRate: rate(answers.filter((a) => a.exact_match).length, answers.length),
      unanswered: answers.filter((a) => a.couldnt_catch || !a.answer_text.trim()).length,
      avgPlaysPerSentence: avg(answers.map((a) => a.playback_start_count)),
      secondPlayRate: rate(answers.filter((a) => a.playback_start_count >= 2).length, answers.length),
      avgActiveMinutesPerTest: avg(attempts.map((a) => a.active_ms / 60000)),
    },
    familiarity: {
      familiar: { sentences: familiar.length, wordAccuracy: avg(familiar.map((a) => a.word_accuracy)) },
      unseen: { sentences: unseen.length, wordAccuracy: avg(unseen.map((a) => a.word_accuracy)), exactSentenceRate: rate(unseen.filter((a) => a.exact_match).length, unseen.length) },
    },
    transfer: (() => {
      const t = answers.filter((a) => a.mode === 'transfer' && a.familiarity_at_start === 'unseen');
      return { sentences: t.length, wordAccuracy: avg(t.map((a) => a.word_accuracy)) };
    })(),
    immediateReview: {
      opened: reviewItems.length,
      completed: immediateDone.length,
      completionRate: rate(immediateDone.length, reviewItems.length),
      selfCorrectionGain: avg(immediateDone.filter((r) => r.self_correction_accuracy != null)
        .map((r) => r.self_correction_accuracy - (originalByItem.get(r.review_item_id) ?? 0))),
      finalRecallAccuracy: avg(immediateDone.map((r) => r.final_recall_accuracy).filter((x) => x != null)),
    },
    delayedReview: {
      attempts: delayed.length,
      passed: delayed.filter((r) => r.delayed_result === 'passed').length,
      passRate: rate(delayed.filter((r) => r.delayed_result === 'passed').length, delayed.length),
      accuracy: avg(delayed.map((r) => r.delayed_accuracy)),
      avgCyclesToPass: avg(passedItems.map((i) => i.delayed_cycles)),
      teacherAttention: reviewItems.filter((i) => i.teacher_attention).length,
    },
    practice: {
      retakes: practice.length,
      retakeAccuracy: avg(practice.map((p) => p.acc)),
      sentenceChecks: freePractice.length,
      sentenceChecksCorrect: rate(freePractice.filter(Boolean).length, freePractice.length),
    },
    timeline: attempts.map((a) => {
      const rows = answers.filter((x) => x.test_id === a.test_id);
      return {
        testId: a.test_id, number: a.number, title: a.title, mode: a.mode, submittedAt: a.submitted_at,
        wordAccuracy: avg(rows.map((r) => r.word_accuracy)),
        exactCount: rows.filter((r) => r.exact_match).length, itemCount: rows.length,
      };
    }),
  };
}
